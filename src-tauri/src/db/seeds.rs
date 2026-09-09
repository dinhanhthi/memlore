//! First-run / idempotent content seeds.
//!
//! Seeds the 3 predefined templates (`blank`, `daily-reflection`,
//! `morning-pages`). Their display name, description, and HTML body are
//! resolved on the frontend through i18n
//! (`editor.templates.<slug>.{label,description,content}`) so the same row
//! renders in whichever supported UI language is active. The `content` BLOB
//! is therefore left empty for predefined rows — user-created templates
//! (`is_predefined = 0`) keep their own per-row content.
//!
//! IDs are deterministic (UUID v5 derived from a fixed namespace + name) so
//! dev-DB wipes + reseeds never produce duplicate-key chaos.
//!
//! Running `ensure_predefined_templates` on an empty DB inserts all 3 rows;
//! running it again is a no-op; user templates (`is_predefined = 0`) are
//! never touched. Predefined rows from a previous release that are no longer
//! in `SEEDS` (e.g. `three-gratitudes`, `travel-log`, `decision-journal`) are
//! deleted on migrate so the on-disk shape matches code.

use rusqlite::{Connection, Result};
use uuid::Uuid;

/// Fixed namespace UUID for deterministic template ids. Treat as an opaque
/// constant — changing it would re-seed with new ids.
const TEMPLATE_NAMESPACE: Uuid = Uuid::from_bytes([
    0x7a, 0x1d, 0x3f, 0x6a, 0xe2, 0x2b, 0x4c, 0x91, 0xa6, 0x94, 0x3d, 0x0e, 0xa5, 0x2c, 0x90, 0xd1,
]);

struct SeedTemplate {
    key: &'static str,
    sort_order: i64,
}

const SEEDS: &[SeedTemplate] = &[
    SeedTemplate {
        key: "blank",
        sort_order: 0,
    },
    SeedTemplate {
        key: "daily-reflection",
        sort_order: 1,
    },
    SeedTemplate {
        key: "morning-pages",
        sort_order: 2,
    },
];

fn template_id(key: &str) -> String {
    Uuid::new_v5(&TEMPLATE_NAMESPACE, key.as_bytes()).to_string()
}

/// Insert-or-refresh the predefined templates. Idempotent and keyed on the
/// deterministic id; `ON CONFLICT DO UPDATE` re-syncs `name`, `description`,
/// `content`, and `sort_order` so code changes to the seed table propagate to
/// existing installations without requiring a DB wipe. Predefined rows from
/// previous releases that are no longer in `SEEDS` are deleted. User-created
/// templates (`is_predefined = 0`) cannot collide with seed ids (UUID v5
/// derived from a fixed namespace) and are therefore untouched.
pub fn ensure_predefined_templates(conn: &Connection) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // 1. Insert / refresh the canonical seed set.
    //
    // `description` and `content` are stored empty for predefined rows because
    // the frontend resolves them through i18n. Keeping the columns lets user
    // templates (is_predefined=0) reuse the same row shape.
    let mut stmt = conn.prepare(
        "INSERT INTO templates \
         (id, name, description, content, is_predefined, sort_order, created_at) \
         VALUES (?1, ?2, '', NULL, 1, ?3, ?4) \
         ON CONFLICT(id) DO UPDATE SET \
            name        = excluded.name, \
            description = excluded.description, \
            content     = excluded.content, \
            sort_order  = excluded.sort_order",
    )?;

    for seed in SEEDS {
        stmt.execute(rusqlite::params![
            template_id(seed.key),
            seed.key,
            seed.sort_order,
            now,
        ])?;
    }
    drop(stmt);

    // 2. Delete any leftover predefined rows from previous releases (e.g.
    //    `three-gratitudes`, `travel-log`, `decision-journal`). We match on
    //    `is_predefined = 1` so user templates are never touched, and exclude
    //    the current seed ids by name so the freshly inserted rows survive.
    let keep_ids: Vec<String> = SEEDS.iter().map(|s| template_id(s.key)).collect();
    let placeholders = keep_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("DELETE FROM templates WHERE is_predefined = 1 AND id NOT IN ({placeholders})");
    let params: Vec<&dyn rusqlite::ToSql> =
        keep_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    conn.execute(&sql, params.as_slice())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    fn count_predefined(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM templates WHERE is_predefined = 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn seeds_three_predefined_templates_on_empty_db() {
        let conn = setup();
        // `migrate` already calls the seeder, so the count should already be 3.
        assert_eq!(count_predefined(&conn), SEEDS.len() as i64);
    }

    #[test]
    fn running_twice_is_a_noop() {
        let conn = setup();
        ensure_predefined_templates(&conn).unwrap();
        ensure_predefined_templates(&conn).unwrap();
        assert_eq!(count_predefined(&conn), SEEDS.len() as i64);
    }

    #[test]
    fn seeded_ids_are_deterministic() {
        let conn = setup();
        let rows: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name FROM templates WHERE is_predefined = 1 \
                     ORDER BY sort_order ASC",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };

        assert_eq!(rows.len(), SEEDS.len());
        for (i, seed) in SEEDS.iter().enumerate() {
            assert_eq!(rows[i].0, template_id(seed.key));
            assert_eq!(rows[i].1, seed.key);
        }
    }

    #[test]
    fn user_templates_are_not_touched_by_reseed() {
        let conn = setup();
        // Insert a user template.
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO templates (id, name, description, content, is_predefined, sort_order, created_at) \
             VALUES ('user-1', 'Mine', 'user', NULL, 0, 0, ?1)",
            [now],
        )
        .unwrap();

        ensure_predefined_templates(&conn).unwrap();

        let name: String = conn
            .query_row("SELECT name FROM templates WHERE id = 'user-1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name, "Mine");
        // User + 3 predefined.
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM templates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, SEEDS.len() as i64 + 1);
    }

    #[test]
    fn seeded_names_match_spec() {
        let conn = setup();
        let names: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM templates WHERE is_predefined = 1 ORDER BY sort_order ASC",
                )
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        // name field stores slug keys; display names are resolved by the
        // frontend via t('editor.templates.' + name + '.label')
        assert_eq!(names, vec!["blank", "daily-reflection", "morning-pages"]);
    }

    #[test]
    fn reseed_deletes_stale_predefined_rows() {
        // Simulate an older DB that still carries predefined rows from a
        // previous release (e.g. `three-gratitudes`). Re-running the seeder
        // must delete them — they're not user data.
        let conn = setup();
        let stale_id = Uuid::new_v5(&TEMPLATE_NAMESPACE, b"three-gratitudes").to_string();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO templates (id, name, description, content, is_predefined, sort_order, created_at) \
             VALUES (?1, 'three-gratitudes', 'old', NULL, 1, 99, ?2)",
            rusqlite::params![stale_id, now],
        )
        .unwrap();
        // Pre-condition: the stale row is in the DB.
        let exists_before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM templates WHERE id = ?1",
                [&stale_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists_before, 1);

        ensure_predefined_templates(&conn).unwrap();

        let exists_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM templates WHERE id = ?1",
                [&stale_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            exists_after, 0,
            "stale predefined rows must be deleted on reseed"
        );
        assert_eq!(count_predefined(&conn), SEEDS.len() as i64);
    }

    #[test]
    fn predefined_content_is_null_or_empty() {
        // Predefined rows store no content — the frontend resolves HTML body
        // from i18n. Custom templates can still use the content column.
        let conn = setup();
        let mut stmt = conn
            .prepare("SELECT content FROM templates WHERE is_predefined = 1")
            .unwrap();
        let blobs: Vec<Option<Vec<u8>>> = stmt
            .query_map([], |r| r.get::<_, Option<Vec<u8>>>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(blobs.len(), SEEDS.len());
        for b in blobs {
            assert!(
                b.as_ref().is_none_or(|v| v.is_empty()),
                "predefined template content must be null or empty"
            );
        }
    }
}
