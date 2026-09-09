//! Invisible multi-vault DB helpers (pure SQLite — no Tauri commands).
//!
//! Each vault is one row in `invisible_vaults` with an Argon2 PHC verifier.
//! Entries/journals bind via `vault_id` when `is_invisible = 1`.

use rusqlite::{Connection, OptionalExtension, Result};
use uuid::Uuid;

use super::queries::{mark_entry_pending, mark_journal_pending};
use crate::utils::invisible_lock::verify_invisible_lock_password;
use crate::utils::time::now_unix;

/// One deniable invisible vault (password verifier only — no content key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvisibleVault {
    pub id: String,
    pub verifier: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_vault(row: &rusqlite::Row<'_>) -> Result<InvisibleVault> {
    Ok(InvisibleVault {
        id: row.get(0)?,
        verifier: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

/// List all vault rows. Order is stable by `created_at ASC, id ASC` for
/// deterministic Argon2 verify-all walks.
pub fn list_invisible_vaults(conn: &Connection) -> Result<Vec<InvisibleVault>> {
    let mut stmt = conn.prepare(
        "SELECT id, verifier, created_at, updated_at
         FROM invisible_vaults
         ORDER BY created_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_vault)?;
    rows.collect()
}

/// Insert a vault with the given Argon2 PHC verifier. Returns the new row.
pub fn insert_invisible_vault(conn: &Connection, verifier: &str) -> Result<InvisibleVault> {
    let id = Uuid::new_v4().to_string();
    let now = now_unix();
    conn.execute(
        "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![id, verifier, now],
    )?;
    get_invisible_vault(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_invisible_vault(conn: &Connection, id: &str) -> Result<Option<InvisibleVault>> {
    conn.query_row(
        "SELECT id, verifier, created_at, updated_at
         FROM invisible_vaults WHERE id = ?1",
        [id],
        row_to_vault,
    )
    .optional()
}

/// Replace the Argon2 PHC verifier for an existing vault.
pub fn update_invisible_vault_verifier(conn: &Connection, id: &str, verifier: &str) -> Result<()> {
    let now = now_unix();
    let affected = conn.execute(
        "UPDATE invisible_vaults
         SET verifier = ?1, updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![verifier, now, id],
    )?;
    if affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Delete a vault row by id. Does **not** reassign or clear items — callers
/// must reassign/clear first (or only delete empty vaults).
pub fn delete_invisible_vault(conn: &Connection, id: &str) -> Result<()> {
    let affected = conn.execute("DELETE FROM invisible_vaults WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Sequential Argon2 verify against every vault. Returns the first matching
/// vault id, or `None` if no verifier matches. O(n) in vault count.
pub fn find_vault_id_by_password(conn: &Connection, password: &str) -> Result<Option<String>> {
    let vaults = list_invisible_vaults(conn)?;
    for vault in vaults {
        if verify_invisible_lock_password(password, &vault.verifier) {
            return Ok(Some(vault.id));
        }
    }
    Ok(None)
}

/// Reassign all non-deleted entries and journals from `from_vault` to
/// `to_vault`, bumping `updated_at` and marking each row pending for sync.
pub fn reassign_vault_items(conn: &Connection, from_vault: &str, to_vault: &str) -> Result<()> {
    if from_vault == to_vault {
        return Ok(());
    }
    let now = now_unix();

    // Collect ids first so we can mark pending after the bulk UPDATE.
    let mut entry_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM entries
             WHERE vault_id = ?1 AND is_deleted = 0",
        )?;
        let rows = stmt.query_map([from_vault], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>>>()?
    };
    let mut journal_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM journals
             WHERE vault_id = ?1 AND is_deleted = 0",
        )?;
        let rows = stmt.query_map([from_vault], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>>>()?
    };

    if !entry_ids.is_empty() {
        conn.execute(
            "UPDATE entries
             SET vault_id = ?1, updated_at = MAX(updated_at + 1, ?2)
             WHERE vault_id = ?3 AND is_deleted = 0",
            rusqlite::params![to_vault, now, from_vault],
        )?;
        for id in &entry_ids {
            mark_entry_pending(conn, id)?;
        }
    }
    if !journal_ids.is_empty() {
        conn.execute(
            "UPDATE journals
             SET vault_id = ?1, updated_at = MAX(updated_at + 1, ?2)
             WHERE vault_id = ?3 AND is_deleted = 0",
            rusqlite::params![to_vault, now, from_vault],
        )?;
        for id in &journal_ids {
            mark_journal_pending(conn, id)?;
        }
    }

    // Silence unused mut warnings if empty — keep mut for clarity of ownership.
    let _ = (&mut entry_ids, &mut journal_ids);
    Ok(())
}

/// Delete vaults that own zero non-deleted entries **and** zero non-deleted
/// journals (README clarification 14). Soft-deleted rows may keep a dangling
/// `vault_id` — those vaults still count as empty. Never returns a count.
pub fn delete_empty_invisible_vaults(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM invisible_vaults
         WHERE id NOT IN (
             SELECT vault_id FROM entries
             WHERE vault_id IS NOT NULL AND is_deleted = 0
             UNION
             SELECT vault_id FROM journals
             WHERE vault_id IS NOT NULL AND is_deleted = 0
         )",
        [],
    )?;
    Ok(())
}

/// MERGE `from_vault` → `to_vault`: reassign items, then delete the source vault.
///
/// Reassignment + source vault delete run in a single transaction so a
/// mid-merge failure cannot leave items without a vault or a half-deleted
/// source vault. `reassign_vault_items` marks every moved entry/journal
/// pending so the new `vault_id` rides the next entry/journal push.
pub fn merge_vaults(conn: &Connection, from_vault: &str, to_vault: &str) -> Result<()> {
    if from_vault == to_vault {
        return Ok(());
    }
    // Ensure both exist before mutating.
    if get_invisible_vault(conn, from_vault)?.is_none() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    if get_invisible_vault(conn, to_vault)?.is_none() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    let tx = conn.unchecked_transaction()?;
    reassign_vault_items(&tx, from_vault, to_vault)?;
    delete_invisible_vault(&tx, from_vault)?;
    tx.commit()?;
    Ok(())
}

// ─── Sync wire format (settings.bin → merge-by-id) ───────────────────────────

/// One vault element on the settings channel (`invisible_vaults_json`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SyncedInvisibleVault {
    pub id: String,
    pub verifier: String,
    pub updated_at: i64,
}

/// Compose the deterministic JSON array of `{id, verifier, updated_at}` from
/// the live `invisible_vaults` table, sorted by `id`. Returns
/// `(json, max_updated_at)` — `max_updated_at` is `0` when the table is empty
/// so content-hash stays stable for the empty-array case.
///
/// Tombstone strategy is **omit** (README clarification 16): deleted/merged
/// vaults simply leave the array. Consequences accepted deliberately:
/// (a) an unsynced peer can re-push a deleted vault (including old verifier),
/// so change-password-with-merge does not retire the old password fleet-wide
/// until every device has synced; (b) a peer's concurrent edits under the
/// merged-away vault stay reachable there instead of being orphaned;
/// (c) `delete_empty_invisible_vaults` runs per device.
pub fn compose_invisible_vaults_json(conn: &Connection) -> Result<(String, i64)> {
    let mut vaults = list_invisible_vaults(conn)?;
    vaults.sort_by(|a, b| a.id.cmp(&b.id));
    let mut max_updated_at: i64 = 0;
    let wire: Vec<SyncedInvisibleVault> = vaults
        .into_iter()
        .map(|v| {
            max_updated_at = max_updated_at.max(v.updated_at);
            SyncedInvisibleVault {
                id: v.id,
                verifier: v.verifier,
                updated_at: v.updated_at,
            }
        })
        .collect();
    let json = serde_json::to_string(&wire).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            e.to_string(),
        )))
    })?;
    Ok((json, max_updated_at))
}

/// Merge remote `invisible_vaults_json` into the local vaults table by id
/// using `updated_at` last-write-wins per id. Never whole-blob replace and
/// never deletes local vaults missing from the remote array (omit strategy).
///
/// Invalid JSON or elements with empty id/verifier are skipped (fail-open
/// for the rest of the array). Returns the number of rows inserted or
/// updated.
pub fn merge_invisible_vaults_from_sync(conn: &Connection, json: &str) -> Result<usize> {
    let remote: Vec<SyncedInvisibleVault> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Ok(0),
    };
    let mut changed = 0usize;
    for item in remote {
        if item.id.is_empty() || item.verifier.is_empty() {
            continue;
        }
        // Same id bounds + charset as every other peer-supplied id channel
        // (MIN_SAFE_ID_BYTES..=MAX_SAFE_ID_BYTES, alnum/-/_). Charset-only
        // was too loose — a 1-char or multi-KB id could land in PK.
        if !crate::db::is_safe_id(&item.id) {
            continue;
        }
        match get_invisible_vault(conn, &item.id)? {
            None => {
                conn.execute(
                    "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params![item.id, item.verifier, item.updated_at],
                )?;
                changed += 1;
            }
            Some(local) if item.updated_at > local.updated_at => {
                conn.execute(
                    "UPDATE invisible_vaults
                     SET verifier = ?1, updated_at = ?2
                     WHERE id = ?3",
                    rusqlite::params![item.verifier, item.updated_at, item.id],
                )?;
                changed += 1;
            }
            _ => {}
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::{
        create_entry, create_journal, get_entry, get_journal, set_entry_invisible,
        set_journal_invisible, CreateEntryParams,
    };
    use crate::db::schema::migrate;
    use crate::utils::invisible_lock::hash_invisible_lock_password;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    #[test]
    fn insert_and_list_vaults_roundtrip() {
        let conn = setup();
        let v1 = insert_invisible_vault(&conn, "phc-one").unwrap();
        let v2 = insert_invisible_vault(&conn, "phc-two").unwrap();
        assert_ne!(v1.id, v2.id);

        let listed = list_invisible_vaults(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed
            .iter()
            .any(|v| v.id == v1.id && v.verifier == "phc-one"));
        assert!(listed
            .iter()
            .any(|v| v.id == v2.id && v.verifier == "phc-two"));
    }

    #[test]
    fn find_vault_id_by_password_matches_correct_vault_only() {
        let conn = setup();
        let phc_a = hash_invisible_lock_password("alpha-pass").unwrap();
        let phc_b = hash_invisible_lock_password("bravo-pass").unwrap();
        let a = insert_invisible_vault(&conn, &phc_a).unwrap();
        let b = insert_invisible_vault(&conn, &phc_b).unwrap();

        assert_eq!(
            find_vault_id_by_password(&conn, "alpha-pass")
                .unwrap()
                .as_deref(),
            Some(a.id.as_str())
        );
        assert_eq!(
            find_vault_id_by_password(&conn, "bravo-pass")
                .unwrap()
                .as_deref(),
            Some(b.id.as_str())
        );
        assert!(find_vault_id_by_password(&conn, "wrong").unwrap().is_none());
    }

    #[test]
    fn reassign_and_merge_moves_items_and_deletes_source() {
        let conn = setup();
        let from = insert_invisible_vault(&conn, "from-phc").unwrap();
        let to = insert_invisible_vault(&conn, "to-phc").unwrap();
        let journal = create_journal(&conn, "J", None).unwrap();
        let entry = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &journal.id,
                title: Some("secret"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1,
            },
        )
        .unwrap();

        set_entry_invisible(&conn, &entry.id, true, Some(&from.id)).unwrap();
        set_journal_invisible(&conn, &journal.id, true, Some(&from.id)).unwrap();

        merge_vaults(&conn, &from.id, &to.id).unwrap();

        assert!(get_invisible_vault(&conn, &from.id).unwrap().is_none());
        assert!(get_invisible_vault(&conn, &to.id).unwrap().is_some());
        let entry = get_entry(&conn, &entry.id).unwrap().unwrap();
        let journal = get_journal(&conn, &journal.id).unwrap().unwrap();
        // Entry may inherit journal vault via COALESCE; own vault_id should be `to`.
        assert_eq!(entry.vault_id.as_deref(), Some(to.id.as_str()));
        assert_eq!(journal.vault_id.as_deref(), Some(to.id.as_str()));
    }

    #[test]
    fn delete_empty_vaults_keeps_non_empty_and_removes_empty() {
        let conn = setup();
        let empty = insert_invisible_vault(&conn, "empty-phc").unwrap();
        let owned = insert_invisible_vault(&conn, "owned-phc").unwrap();
        let journal = create_journal(&conn, "J", None).unwrap();
        let entry = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &journal.id,
                title: Some("secret"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1,
            },
        )
        .unwrap();
        set_entry_invisible(&conn, &entry.id, true, Some(&owned.id)).unwrap();

        // Soft-deleted entry on empty vault must NOT keep it alive.
        let soft = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &journal.id,
                title: Some("gone"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 2,
            },
        )
        .unwrap();
        set_entry_invisible(&conn, &soft.id, true, Some(&empty.id)).unwrap();
        conn.execute(
            "UPDATE entries SET is_deleted = 1 WHERE id = ?1",
            [&soft.id],
        )
        .unwrap();

        delete_empty_invisible_vaults(&conn).unwrap();

        assert!(
            get_invisible_vault(&conn, &empty.id).unwrap().is_none(),
            "empty vault (only soft-deleted items) must be removed"
        );
        assert!(
            get_invisible_vault(&conn, &owned.id).unwrap().is_some(),
            "vault with live entry must remain"
        );
    }

    #[test]
    fn update_vault_verifier_rewrites_phc() {
        let conn = setup();
        let vault = insert_invisible_vault(&conn, "old-phc").unwrap();
        update_invisible_vault_verifier(&conn, &vault.id, "new-phc").unwrap();
        let updated = get_invisible_vault(&conn, &vault.id).unwrap().unwrap();
        assert_eq!(updated.verifier, "new-phc");
        assert!(updated.updated_at >= vault.updated_at);
    }

    #[test]
    fn merge_marks_entries_and_journals_pending() {
        let conn = setup();
        let from = insert_invisible_vault(&conn, "from-phc").unwrap();
        let to = insert_invisible_vault(&conn, "to-phc").unwrap();
        let journal = create_journal(&conn, "J", None).unwrap();
        let entry = create_entry(
            &conn,
            CreateEntryParams {
                journal_id: &journal.id,
                title: Some("secret"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1,
            },
        )
        .unwrap();
        set_entry_invisible(&conn, &entry.id, true, Some(&from.id)).unwrap();
        set_journal_invisible(&conn, &journal.id, true, Some(&from.id)).unwrap();

        // Simulate a prior successful push: stamp synced at current version.
        let entry_ver = crate::db::queries::get_entry_local_version(&conn, &entry.id)
            .unwrap()
            .unwrap();
        crate::db::queries::mark_entry_synced(&conn, &entry.id, entry_ver).unwrap();
        let journal_ver = crate::db::queries::get_journal_local_version(&conn, &journal.id)
            .unwrap()
            .unwrap();
        crate::db::queries::mark_journal_synced(&conn, &journal.id, journal_ver).unwrap();
        assert_eq!(crate::db::queries::count_pending_entries(&conn).unwrap(), 0);

        merge_vaults(&conn, &from.id, &to.id).unwrap();

        let pending_entries = crate::db::queries::list_pending_entry_ids(&conn).unwrap();
        assert!(
            pending_entries.contains(&entry.id),
            "merge reassign must mark entry pending so vault_id re-uploads"
        );
        let pending_journals = crate::db::queries::list_pending_journal_ids(&conn).unwrap();
        assert!(
            pending_journals.contains(&journal.id),
            "merge reassign must mark journal pending so vault_id re-uploads"
        );
        let entry_ver_after = crate::db::queries::get_entry_local_version(&conn, &entry.id)
            .unwrap()
            .unwrap();
        assert!(
            entry_ver_after > entry_ver,
            "local_version must bump once per reassigned entry"
        );
    }

    #[test]
    fn compose_vaults_json_is_sorted_by_id_and_stable() {
        let conn = setup();
        // Insert in reverse id order by forcing ids via raw SQL.
        conn.execute(
            "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
             VALUES ('z-vault', 'phc-z', 1, 10)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
             VALUES ('a-vault', 'phc-a', 2, 20)",
            [],
        )
        .unwrap();
        let (json1, max_ts) = compose_invisible_vaults_json(&conn).unwrap();
        let (json2, _) = compose_invisible_vaults_json(&conn).unwrap();
        assert_eq!(
            json1, json2,
            "compose must be deterministic for content-hash"
        );
        assert_eq!(max_ts, 20);
        let parsed: Vec<SyncedInvisibleVault> = serde_json::from_str(&json1).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "a-vault");
        assert_eq!(parsed[1].id, "z-vault");
    }

    #[test]
    fn merge_by_id_keeps_both_devices_and_newer_verifier_wins() {
        let conn = setup();
        // Ids must pass is_safe_id (>= 8 chars). Local has vault-aa (older).
        conn.execute(
            "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
             VALUES ('vault-aa', 'phc-a-old', 1, 100)",
            [],
        )
        .unwrap();

        // Remote device publishes vault-aa (newer) + vault-bb (new).
        let remote = serde_json::to_string(&[
            SyncedInvisibleVault {
                id: "vault-aa".to_string(),
                verifier: "phc-a-new".to_string(),
                updated_at: 200,
            },
            SyncedInvisibleVault {
                id: "vault-bb".to_string(),
                verifier: "phc-b".to_string(),
                updated_at: 150,
            },
        ])
        .unwrap();
        let n = merge_invisible_vaults_from_sync(&conn, &remote).unwrap();
        assert_eq!(n, 2);

        let a = get_invisible_vault(&conn, "vault-aa").unwrap().unwrap();
        assert_eq!(a.verifier, "phc-a-new");
        assert_eq!(a.updated_at, 200);
        let b = get_invisible_vault(&conn, "vault-bb").unwrap().unwrap();
        assert_eq!(b.verifier, "phc-b");

        // Older remote must not rewind local newer verifier.
        let stale = serde_json::to_string(&[SyncedInvisibleVault {
            id: "vault-aa".to_string(),
            verifier: "phc-a-stale".to_string(),
            updated_at: 50,
        }])
        .unwrap();
        assert_eq!(merge_invisible_vaults_from_sync(&conn, &stale).unwrap(), 0);
        assert_eq!(
            get_invisible_vault(&conn, "vault-aa")
                .unwrap()
                .unwrap()
                .verifier,
            "phc-a-new"
        );

        // Local-only vault-cc must survive remote that omits it (no tombstone).
        conn.execute(
            "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
             VALUES ('vault-cc', 'phc-c', 1, 300)",
            [],
        )
        .unwrap();
        let only_b = serde_json::to_string(&[SyncedInvisibleVault {
            id: "vault-bb".to_string(),
            verifier: "phc-b".to_string(),
            updated_at: 150,
        }])
        .unwrap();
        merge_invisible_vaults_from_sync(&conn, &only_b).unwrap();
        assert!(
            get_invisible_vault(&conn, "vault-cc").unwrap().is_some(),
            "omit strategy must not delete local-only vaults"
        );
    }

    #[test]
    fn merge_from_sync_rejects_short_and_oversize_ids() {
        use crate::db::queries::MAX_SAFE_ID_BYTES;

        let conn = setup();
        let short_id = "short"; // 5 < MIN_SAFE_ID_BYTES (8)
        let oversize_id = "x".repeat(MAX_SAFE_ID_BYTES + 1);
        let safe_id = "vault-ok1";

        let remote = serde_json::to_string(&[
            SyncedInvisibleVault {
                id: short_id.to_string(),
                verifier: "phc-short".to_string(),
                updated_at: 100,
            },
            SyncedInvisibleVault {
                id: oversize_id.clone(),
                verifier: "phc-over".to_string(),
                updated_at: 100,
            },
            SyncedInvisibleVault {
                id: "bad/id!".to_string(),
                verifier: "phc-charset".to_string(),
                updated_at: 100,
            },
            SyncedInvisibleVault {
                id: safe_id.to_string(),
                verifier: "phc-ok".to_string(),
                updated_at: 100,
            },
        ])
        .unwrap();

        let n = merge_invisible_vaults_from_sync(&conn, &remote).unwrap();
        assert_eq!(n, 1, "only safe-length id should insert");
        assert!(get_invisible_vault(&conn, short_id).unwrap().is_none());
        assert!(get_invisible_vault(&conn, &oversize_id).unwrap().is_none());
        assert!(get_invisible_vault(&conn, "bad/id!").unwrap().is_none());
        assert!(get_invisible_vault(&conn, safe_id).unwrap().is_some());
    }
}
