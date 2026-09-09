//! Database queries for the AI user-memory store: `memory_items`,
//! `memory_item_sources`, `memory_embeddings`, and the scan-driven
//! extraction watermark queue `memory_jobs`.
//!
//! This module is the Phase 1 DB layer (plan `2026-07-29-ai-user-memory`,
//! Task T1.2). It mirrors the column shapes and queue patterns in
//! [`crate::db::embeddings`] but with two structural differences driven by
//! the scan-driven extraction model (see plan decision notes):
//!
//! - `memory_jobs` is a *watermark* table keyed by `(source_type,
//!   source_id)`. A scan finds sources whose live content hash changed vs.
//!   the stored row and calls [`upsert_memory_job_watermark`] to (re)queue
//!   them — there is no save-triggered "mark dirty" path like
//!   `mark_entry_embedding_dirty`.
//! - [`claim_due_memory_jobs`] does NOT join `entries`/`journals` and has no
//!   `model_id` filter (memory jobs are not model-scoped). The
//!   privacy/lock re-check for contributing journal entries happens at
//!   *retrieval* time in Phase 1 Task T1.3 ([`retrieve_top_k_memories`]),
//!   not at claim time — unlike [`crate::db::embeddings::claim_due_embedding_jobs`]
//!   which guards locked/invisible entries when claiming.
//!
//! Vectors reuse the little-endian f32 encoding from [`crate::db::embeddings`]
//! ([`crate::db::embeddings::vec_to_blob`]); retrieval (cosine ranking) lands
//! in T1.3.

use rusqlite::{params, Connection, OptionalExtension, Result};

use crate::db::embeddings::{blob_to_vec, cosine_unit, vec_to_blob};

// ---------------------------------------------------------------------------
// Row structs
// ---------------------------------------------------------------------------

/// One distilled user fact. Booleans are stored as `i64` (SQLite has no bool
/// type); convert with `!= 0` on read. `Serialize` + `camelCase` lets the
/// Phase 5 `list_memory_items` command return `Vec<MemoryItemRow>` across IPC
/// without a command-side DTO; `isDeleted` is always `false` in that path
/// ([`list_memory_items`] filters `is_deleted = 0`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItemRow {
    pub id: String,
    pub text: String,
    pub source_type: String,
    pub enabled: bool,
    pub is_deleted: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One contributing source behind a memory item (the many side of the
/// `memory_item_sources` join).
#[derive(Debug, Clone, PartialEq)]
pub struct MemorySourceRow {
    pub source_type: String,
    pub source_id: String,
}

/// One row of the `memory_jobs` watermark queue. Mirrors
/// [`crate::db::embeddings::EmbeddingJobRow`] minus the entry/model keys.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryJobRow {
    pub source_type: String,
    pub source_id: String,
    pub content_hash: String,
    pub status: String,
    pub attempt_count: i64,
    pub next_attempt_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// memory_items CRUD
// ---------------------------------------------------------------------------

/// Insert a new memory item with `enabled = 1`, `is_deleted = 0`, and
/// `created_at = updated_at = now`. `source_type` is validated by the DB
/// CHECK constraint (`'journal_entry' | 'daily_chat'`) — an invalid value
/// surfaces as a `Result::Err` from the constraint violation.
pub fn insert_memory_item(
    conn: &Connection,
    id: &str,
    text: &str,
    source_type: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_items
            (id, text, source_type, enabled, is_deleted, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, 0, ?4, ?4)",
        params![id, text, source_type, now],
    )?;
    Ok(())
}

/// Update a memory item's text and bump `updated_at`. Also deletes any
/// `memory_embeddings` rows for the item so it gets re-embedded against the
/// new text — a stale vector from the old text must not survive an edit.
/// Both writes run in a single transaction so a crash between the text
/// update and the embedding wipe cannot leave a vector pinned to outdated
/// text.
pub fn update_memory_item_text(conn: &Connection, id: &str, text: &str, now: i64) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    // `is_deleted = 0` is defense in depth: callers pre-check liveness, but a
    // concurrent pass may have tombstoned the row between their check and
    // this write (e.g. two overlapping consolidations merging in opposite
    // directions) — rewriting a tombstone would resurrect its text on peers
    // via LWW and orphan the embedding row inserted right after.
    let changed = tx.execute(
        "UPDATE memory_items
         SET text = ?2, updated_at = MAX(updated_at + 1, ?3)
         WHERE id = ?1 AND is_deleted = 0",
        params![id, text, now],
    )?;
    if changed > 0 {
        tx.execute(
            "DELETE FROM memory_embeddings WHERE memory_id = ?1",
            params![id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Atomically fold `absorb` items into `keep` (the consolidation Merge op):
/// every absorbed item's source links are copied onto `keep`, the absorbed
/// items are tombstoned, and `keep`'s text is replaced — all in ONE
/// transaction, so a mid-merge failure can never tombstone an absorbed fact
/// without the merged text that preserves it landing on `keep`.
///
/// Source copy BEFORE tombstone is the privacy invariant: the retrieval-time
/// locked/invisible re-check must keep seeing every entry that fed the
/// merged fact (same laundering hazard `remove_memory_source_cascade`
/// documents).
///
/// Absorb ids that are missing or already tombstoned are skipped. Returns
/// `Ok(false)` — with NOTHING written — when `keep` is missing/tombstoned or
/// no absorb id was live; `Ok(true)` when the merge committed. Callers
/// re-embed `keep` afterwards (this fn clears its embedding rows like
/// [`update_memory_item_text`]).
pub fn merge_memory_items(
    conn: &Connection,
    keep: &str,
    absorb: &[String],
    text: &str,
    now: i64,
) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let keep_live: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM memory_items WHERE id = ?1 AND is_deleted = 0 LIMIT 1",
            params![keep],
            |row| row.get(0),
        )
        .optional()?;
    if keep_live.is_none() {
        return Ok(false);
    }
    let mut absorbed_any = false;
    for a in absorb {
        let live: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM memory_items WHERE id = ?1 AND is_deleted = 0 LIMIT 1",
                params![a],
                |row| row.get(0),
            )
            .optional()?;
        if live.is_none() {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO memory_item_sources (memory_id, source_type, source_id)
             SELECT ?1, source_type, source_id FROM memory_item_sources WHERE memory_id = ?2",
            params![keep, a],
        )?;
        tx.execute(
            "UPDATE memory_items
             SET is_deleted = 1, updated_at = MAX(updated_at + 1, ?2)
             WHERE id = ?1",
            params![a, now],
        )?;
        absorbed_any = true;
    }
    if !absorbed_any {
        return Ok(false);
    }
    tx.execute(
        "UPDATE memory_items
         SET text = ?2, updated_at = MAX(updated_at + 1, ?3)
         WHERE id = ?1 AND is_deleted = 0",
        params![keep, text, now],
    )?;
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![keep],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Toggle a memory item's `enabled` flag (hides it from retrieval without
/// deleting it) and bump `updated_at`.
pub fn set_memory_enabled(conn: &Connection, id: &str, enabled: bool, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE memory_items
         SET enabled = ?2, updated_at = MAX(updated_at + 1, ?3)
         WHERE id = ?1",
        params![id, enabled as i64, now],
    )?;
    Ok(())
}

/// Soft-delete (tombstone) a memory item: set `is_deleted = 1` and bump
/// `updated_at`. The row is NOT deleted from the table — the tombstone
/// propagates via sync (last-writer-wins on `updated_at`), so physical
/// deletion would lose the "this was deleted" signal on other devices.
pub fn tombstone_memory_item(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE memory_items
         SET is_deleted = 1, updated_at = MAX(updated_at + 1, ?2)
         WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// `true` when a non-deleted memory item with `id` exists. Tombstoned items
/// return `false`, so update/delete ops on them are skipped rather than
/// reanimating or re-tombstoning. Cheaper than [`list_memory_items`]: a
/// single existence probe (`SELECT 1 ... LIMIT 1`) instead of materializing
/// every non-deleted row — called once per Update/Delete op in `apply_ops`.
pub fn memory_item_exists(conn: &Connection, id: &str) -> Result<bool> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM memory_items WHERE id = ?1 AND is_deleted = 0 LIMIT 1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(exists.is_some())
}

/// List all non-deleted memory items, newest (`updated_at`) first — the
/// shape the UI memory list renders.
pub fn list_memory_items(conn: &Connection) -> Result<Vec<MemoryItemRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, text, source_type, enabled, is_deleted, created_at, updated_at
         FROM memory_items
         WHERE is_deleted = 0
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let enabled: i64 = row.get(3)?;
        let is_deleted: i64 = row.get(4)?;
        Ok(MemoryItemRow {
            id: row.get(0)?,
            text: row.get(1)?,
            source_type: row.get(2)?,
            enabled: enabled != 0,
            is_deleted: is_deleted != 0,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>>>()
}

/// Return an item's current text, including tombstones, for sync-side
/// validation of an incoming embedding's content hash.
pub fn memory_item_text_for_sync(conn: &Connection, id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT text FROM memory_items WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
}

// ---------------------------------------------------------------------------
// memory_item_sources
// ---------------------------------------------------------------------------

/// Add a contributing source for a memory item. `INSERT OR IGNORE` so a
/// repeated (memory_id, source_type, source_id) link is a no-op rather than
/// a PK violation — the extractor can re-assert the same linkage each scan.
pub fn add_memory_source(
    conn: &Connection,
    memory_id: &str,
    source_type: &str,
    source_id: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO memory_item_sources
            (memory_id, source_type, source_id)
         VALUES (?1, ?2, ?3)",
        params![memory_id, source_type, source_id],
    )?;
    Ok(())
}

/// List all contributing sources for a memory item.
pub fn list_sources_for_memory(conn: &Connection, memory_id: &str) -> Result<Vec<MemorySourceRow>> {
    let mut stmt = conn.prepare(
        "SELECT source_type, source_id
         FROM memory_item_sources
         WHERE memory_id = ?1",
    )?;
    let rows = stmt.query_map(params![memory_id], |row| {
        Ok(MemorySourceRow {
            source_type: row.get(0)?,
            source_id: row.get(1)?,
        })
    })?;
    rows.collect::<Result<Vec<_>>>()
}

// ---------------------------------------------------------------------------
// Source-deletion cascade (bugfix — orphaned memories after source delete)
// ---------------------------------------------------------------------------

/// Clean up memory state after a source (`journal_entry` or `daily_chat`) is
/// soft-deleted, so its distilled fact(s) do not stay retrievable forever.
/// `memory_item_sources` has NO foreign key to `entries`/`chat_sessions`
/// (intentional — see `schema.rs`'s comment on the table), so nothing
/// enforces this automatically; every caller (entry soft-delete, journal
/// bulk-delete, chat-session delete, and the sync engine's peer-tombstone
/// apply) runs this inside the SAME transaction as the source's own
/// tombstone write, so the cleanup is atomic with the delete.
///
/// 1. For `journal_entry` sources: check whether the entry being removed is
///    CURRENTLY locked or invisible. If so, every memory item it contributed
///    to is tombstoned OUTRIGHT in step 3, regardless of other surviving
///    sources (C1 fix). This check must run BEFORE step 2 deletes the
///    entry's own `memory_item_sources` row — once that row is gone, the
///    retrieval-time privacy re-check ([`retrieve_top_k_memories`]) can no
///    longer see that this memory was ever sourced from a locked/invisible
///    entry, so a surviving unlocked co-source would otherwise "launder" the
///    locked entry's contribution back into retrieval.
/// 2. Deletes every `memory_item_sources` row for `(source_type,
///    source_id)`.
/// 3. For each memory item that contributed to (had a row deleted in step 2):
///    tombstoned (`is_deleted = 1`, `updated_at` bumped to `now`) when EITHER
///    the removed source was a protected entry (step 1), OR it now has
///    **zero** remaining sources. NOT a hard delete, so the tombstone still
///    propagates via sync LWW instead of being resurrected by the next peer
///    pull (see `upsert_memory_item_lww`). A memory item with other
///    surviving sources, removed for a non-protected reason, is left
///    untouched.
/// 4. Deletes the `memory_jobs` watermark row for `(source_type, source_id)`
///    — there is nothing left to re-scan for a deleted source.
///
/// There is no entry/session-restore path in this app, so cascading on
/// soft-delete is safe: a deleted source can never come back and reclaim its
/// memory.
///
/// **Sync interaction (I4 — do NOT redesign the sync merge for this).** Phase
/// 6 sync (`docs/plans/2026-07-29-ai-user-memory/phase-6-sync.md`) union-merges
/// `memory_item_sources` on pull and never removes rows, so a stale peer
/// `memory.bin` can re-add a source row this cascade just deleted (step 2).
/// That is harmless: a re-added `journal_entry` source still points at an
/// entry row whose `is_deleted`/lock/invisible state
/// [`retrieve_top_k_memories`]'s fail-closed re-check drops on, and a
/// re-added source on an already-tombstoned memory item does nothing (the
/// item's own `is_deleted = 1` already excludes it everywhere).
pub fn cleanup_memory_for_deleted_source(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<()> {
    // Step 1 (C1 fix): was this source a locked/invisible journal_entry?
    // Must run BEFORE the source row is deleted below.
    //
    // Bugfix (💡 review pass 2): this probe used to INNER JOIN `entries` /
    // `journals`, which fails OPEN on a missing row (no match = "not
    // protected" = safe to leave alone) — the opposite posture of the
    // retrieval-time recheck in this same file. A LEFT JOIN driven from a
    // one-row `(SELECT ?1 AS id)` derived table, with `e.id IS NULL` folded
    // into the OR, fails CLOSED instead: an uncertain/missing source is
    // treated as protected, so step 3 below tombstones the memory outright
    // rather than risk laundering it via a surviving co-source.
    let source_was_protected = if source_type == "journal_entry" {
        let locked_pred = crate::db::queries::locked_entry_exclusion_predicate();
        let invisible_pred = crate::db::queries::invisible_entry_exclusion_predicate();
        conn.query_row(
            &format!(
                "SELECT 1
                 FROM (SELECT ?1 AS id) probe
                 LEFT JOIN entries e ON e.id = probe.id
                 LEFT JOIN journals j ON j.id = e.journal_id
                 WHERE e.id IS NULL OR NOT ({locked_pred}) OR NOT ({invisible_pred})"
            ),
            params![source_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    } else {
        false
    };

    // Snapshot which memory items had a source pointing at this source
    // BEFORE deleting the source rows, so step 3 only re-checks items that
    // could possibly be affected.
    let affected: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT memory_id FROM memory_item_sources
             WHERE source_type = ?1 AND source_id = ?2",
        )?;
        let rows = stmt.query_map(params![source_type, source_id], |row| {
            row.get::<_, String>(0)
        })?;
        rows.collect::<Result<Vec<_>>>()?
    };

    // I4: this DELETE is exactly the row a stale peer `memory.bin` can
    // re-add via sync's union-merge — see the fn doc above for why that is
    // harmless given the retrieval-time fail-closed re-check.
    conn.execute(
        "DELETE FROM memory_item_sources
         WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id],
    )?;

    for memory_id in &affected {
        if source_was_protected {
            tombstone_memory_item(conn, memory_id, now)?;
            continue;
        }
        let remaining: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memory_item_sources WHERE memory_id = ?1",
            params![memory_id],
            |row| row.get(0),
        )?;
        if remaining == 0 {
            tombstone_memory_item(conn, memory_id, now)?;
        }
    }

    conn.execute(
        "DELETE FROM memory_jobs WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id],
    )?;
    Ok(())
}

/// Set-based equivalent of calling [`cleanup_memory_for_deleted_source`] once
/// per `journal_entry` id — used where the per-row loop is too slow at scale:
/// [`crate::db::queries::delete_journal`] (I9 fix — up to ~20-25k prepared
/// statements for a 5,000-entry journal, all serialized under the single
/// global `AppState` connection mutex, blocking every Tauri command
/// app-wide) and [`crate::db::queries::hard_wipe_user_data`] (C5 fix —
/// Replace-all import). Exactly 4 statements regardless of how many entries
/// are in scope.
///
/// Preserves the per-row cascade's C1(a) semantics precisely: a memory item
/// with ANY deleted source that is CURRENTLY locked/invisible is tombstoned
/// WHOLE, regardless of surviving sources; a memory item left with zero
/// remaining sources afterward is also tombstoned; everything else survives
/// untouched. Only `journal_entry` sources are affected here — `daily_chat`
/// cleanup stays per-session via [`cleanup_memory_for_deleted_source`].
///
/// `journal_id`: `Some(id)` scopes to one journal's entries (`delete_journal`
/// deletes one journal at a time); `None` covers EVERY entry currently in
/// the table (`hard_wipe_user_data` wipes the whole catalog).
///
/// **Ordering contract — LOAD-BEARING, not an optimization** (same as the
/// per-row cascade): the caller MUST run this BEFORE physically removing the
/// affected `entries` rows. A soft delete (`is_deleted = 1`) is fine — the
/// lock/invisible predicates never consult `is_deleted` — but calling this
/// AFTER a HARD delete (as `hard_wipe_user_data` performs) is a SILENT
/// TOTAL NO-OP, not a safe-but-wasteful fail-closed tombstone: step 1's
/// `JOIN entries e` and step 2/3's `source_id IN (SELECT id FROM entries
/// ...)` both match zero rows once the entries are gone, so nothing gets
/// tombstoned or cleaned up at all — the exact orphaned-source laundering
/// bug (C5) this fn exists to close. Unlike the single-row probe above,
/// this fn's steps drive FROM the live `entries` table rather than
/// LEFT-JOINing a caller-supplied id, so there is no missing-row fallback
/// to fail closed onto here — get the ordering right instead.
pub fn cleanup_memory_for_entries_bulk(
    conn: &Connection,
    journal_id: Option<&str>,
    now: i64,
) -> Result<()> {
    let locked_pred = crate::db::queries::locked_entry_exclusion_predicate();
    let invisible_pred = crate::db::queries::invisible_entry_exclusion_predicate();

    // Step 1 (C1(a)): tombstone WHOLE any memory item with a `journal_entry`
    // source in scope that is currently locked or invisible — before its
    // source row is touched by step 3. LEFT JOIN `journals` (not INNER) so
    // an entry with an orphaned `journal_id` still gets evaluated — the
    // predicates already COALESCE a missing `j` to "not locked/invisible",
    // matching the fail-closed posture the single-row probe above uses.
    let step1_scope = if journal_id.is_some() {
        " AND e.journal_id = ?2"
    } else {
        ""
    };
    let step1_sql = format!(
        "UPDATE memory_items
         SET is_deleted = 1, updated_at = MAX(updated_at + 1, ?1)
         WHERE is_deleted = 0
           AND id IN (
             SELECT DISTINCT s.memory_id
             FROM memory_item_sources s
             JOIN entries e ON e.id = s.source_id
             LEFT JOIN journals j ON j.id = e.journal_id
             WHERE s.source_type = 'journal_entry'{step1_scope}
               AND (NOT ({locked_pred}) OR NOT ({invisible_pred}))
           )"
    );
    match journal_id {
        Some(jid) => conn.execute(&step1_sql, params![now, jid])?,
        None => conn.execute(&step1_sql, params![now])?,
    };

    // Step 2 (zero-remaining-sources tombstone) — MUST run BEFORE step 3
    // deletes the source rows below, since it reads `memory_item_sources`
    // to decide "would this item have zero sources left". Fixed after
    // review: an earlier version ran this unscoped AFTER the delete
    // (`NOT EXISTS (... WHERE memory_id = id)`), which is correct only
    // under the assumption that every live memory item always has >= 1
    // source — an invariant of the extraction path, NOT of the sync path
    // (a peer-adopted item can arrive with a source list that gets
    // filtered down to zero, e.g. `is_safe_id` rejecting a short/oversize
    // id). That version would tombstone ANY pre-existing zero-source item
    // repo-wide on every `delete_journal` / Replace-all import, not just
    // items this call actually affects. This version instead expresses
    // "will have zero sources left" directly: the item has at least one
    // `journal_entry` source IN scope (so this call actually touches it),
    // AND has no source of ANY kind outside scope (so nothing survives).
    // A genuinely unrelated zero-source item has no in-scope source at
    // all, so the first condition excludes it and it is correctly left
    // alone.
    // step2_sql binds `now` as ?1, so its scope filter (used twice) must
    // reference ?2 — a DIFFERENT placeholder number from the single-param
    // scope filter steps 3/4 use below. Reusing the same literal string
    // across statements with different param layouts is exactly the kind
    // of off-by-one this fn must not ship with.
    let step2_scope = if journal_id.is_some() {
        " AND journal_id = ?2"
    } else {
        ""
    };
    let step2_sql = format!(
        "UPDATE memory_items
         SET is_deleted = 1, updated_at = MAX(updated_at + 1, ?1)
         WHERE is_deleted = 0
           AND id IN (
             SELECT memory_id FROM memory_item_sources
             WHERE source_type = 'journal_entry'
               AND source_id IN (SELECT id FROM entries WHERE 1=1{step2_scope})
           )
           AND NOT EXISTS (
             SELECT 1 FROM memory_item_sources ms
             WHERE ms.memory_id = memory_items.id
               AND NOT (
                 ms.source_type = 'journal_entry'
                 AND ms.source_id IN (SELECT id FROM entries WHERE 1=1{step2_scope})
               )
           )"
    );
    match journal_id {
        Some(jid) => conn.execute(&step2_sql, params![now, jid])?,
        None => conn.execute(&step2_sql, params![now])?,
    };

    // Steps 3/4 each take only the (optional) journal_id param, so their
    // scope filter is ?1.
    let single_param_scope = if journal_id.is_some() {
        " AND journal_id = ?1"
    } else {
        ""
    };

    // Step 3: delete every `journal_entry` source row in scope.
    let step3_sql = format!(
        "DELETE FROM memory_item_sources
         WHERE source_type = 'journal_entry'
           AND source_id IN (SELECT id FROM entries WHERE 1=1{single_param_scope})"
    );
    match journal_id {
        Some(jid) => conn.execute(&step3_sql, params![jid])?,
        None => conn.execute(&step3_sql, [])?,
    };

    // Step 4: drop the `memory_jobs` watermark rows for entries in scope —
    // nothing left to re-scan for a removed source.
    let step4_sql = format!(
        "DELETE FROM memory_jobs
         WHERE source_type = 'journal_entry'
           AND source_id IN (SELECT id FROM entries WHERE 1=1{single_param_scope})"
    );
    match journal_id {
        Some(jid) => conn.execute(&step4_sql, params![jid])?,
        None => conn.execute(&step4_sql, [])?,
    };

    Ok(())
}

// ---------------------------------------------------------------------------
// memory_embeddings
// ---------------------------------------------------------------------------

/// Upsert the embedding vector for `(memory_id, model_id)`. `vec` is encoded
/// little-endian f32 via [`vec_to_blob`]. An existing row for the same key
/// is replaced in place (memory embed slot swap, or a re-embed after a text
/// edit cleared the prior row via [`update_memory_item_text`]).
pub fn upsert_memory_embedding(
    conn: &Connection,
    memory_id: &str,
    model_id: &str,
    dim: i64,
    vec: &[f32],
    content_hash: &str,
    now: i64,
) -> Result<()> {
    let blob = vec_to_blob(vec);
    conn.execute(
        "INSERT INTO memory_embeddings
            (memory_id, model_id, dim, vec, content_hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(memory_id, model_id) DO UPDATE SET
            dim = excluded.dim,
            vec = excluded.vec,
            content_hash = excluded.content_hash,
            indexed_at = excluded.indexed_at",
        params![memory_id, model_id, dim, blob, content_hash, now],
    )?;
    Ok(())
}

/// List the ids of enabled, non-deleted memory items that have NO row in
/// `memory_embeddings` for `model_id` — a left anti-join. This backs the
/// worker's backfill pass: after a memory-embed slot swap (or a text edit
/// that wiped the prior vector), these are the items the worker must
/// re-embed under the active `model_id`.
pub fn list_memory_ids_missing_embedding_for_model(
    conn: &Connection,
    model_id: &str,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT m.id
         FROM memory_items m
         LEFT JOIN memory_embeddings e
           ON e.memory_id = m.id AND e.model_id = ?1
         WHERE m.enabled = 1
           AND m.is_deleted = 0
           AND e.memory_id IS NULL",
    )?;
    let rows = stmt.query_map(params![model_id], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>>>()
}

// ---------------------------------------------------------------------------
// retrieval — cosine ranking + retrieval-time privacy re-check
// ---------------------------------------------------------------------------

/// One cosine-ranked memory retrieval hit — the distilled fact text plus the
/// score it ranked at, for chat RAG injection.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryHit {
    pub memory_id: String,
    pub text: String,
    pub score: f32,
}

/// Return the top-`k` enabled, non-deleted memory items ranked by cosine
/// similarity against `query_vec` for the active memory-embed `model_id`,
/// dropping any hit whose score is below `min_score`.
///
/// Unlike entry-chunk retrieval ([`crate::db::embeddings::retrieve_top_k`]),
/// there is no grouping step: each memory item carries exactly one stored
/// vector per `model_id`, so the candidate set is already one row per item.
/// NaN scores are skipped defensively (same guard as the entry path).
///
/// **`min_score` (bugfix — "N memories used" on unrelated questions). This
/// doc is the CANONICAL explanation of the two-floors split (💡 review pass
/// 2) — `commands::ai::CHAT_MEMORY_MIN_SIMILARITY` and
/// `commands::ai_memory::CONSOLIDATION_MIN_SCORE` (both private consts,
/// plain backticks not intra-doc links) each carry only a short pointer
/// back here; do not re-derive the tradeoff at either site.**
/// Without a floor, the top-`k` nearest items are returned even when NONE of
/// them are actually related to the query — an unrelated Daily Chat question
/// would still report every slot as "used" and inject irrelevant facts into
/// the prompt. Callers choose the floor:
/// - Chat retrieval ([`crate::commands::ai::gather_chat_memories`]) passes a
///   real relevance floor (`CHAT_MEMORY_MIN_SIMILARITY`) so only
///   genuinely-related memories count as "used".
/// - Extraction-time consolidation
///   ([`crate::commands::ai_memory::extract_memories_for_source`]) passes a
///   permissive floor (`CONSOLIDATION_MIN_SCORE`) so the model still sees
///   its K nearest existing memories regardless of relevance — consolidation
///   needs the full neighborhood to decide add/update/delete, not just the
///   "close enough" subset. Do NOT hardcode a threshold in this fn; the two
///   call sites have deliberately different tolerances.
///
/// **Privacy re-check (plan decision 8 — load-bearing):** after ranking +
/// truncation, each surviving hit is re-checked against the CURRENT lock /
/// invisible state of its contributing journal entries. For any hit that has
/// at least one `journal_entry` source, the source is LEFT-joined through
/// `entries e → journals j` and the memory is DROPPED if ANY contributing
/// entry:
/// - is MISSING (no `entries` row — an orphaned source), OR
/// - has `is_deleted = 1` (soft-deleted), OR
/// - belongs to a journal with `is_deleted = 1` (💡 review pass 2 — the
///   entry's own row can lag its journal's tombstone across the two
///   independent entry/journal sync channels; checking only `e.is_deleted`
///   missed this), OR
/// - currently fails [`crate::db::queries::locked_entry_exclusion_predicate`]
///   OR [`crate::db::queries::invisible_entry_exclusion_predicate`].
///
/// A memory distilled from an entry that has since been locked, made
/// invisible, or deleted must never be injected into a prompt. The LEFT JOIN
/// (rather than an INNER JOIN) is what makes the missing/deleted cases fail
/// CLOSED (C1 fix) — an INNER JOIN silently drops non-matching rows, which
/// would fail OPEN (keep) exactly when the source is missing or deleted.
/// Memories with only `daily_chat` sources have no lockable target and are
/// never dropped by this check (an accepted boundary, per plan decision 8 /
/// "Not Building").
pub fn retrieve_top_k_memories(
    conn: &Connection,
    query_vec: &[f32],
    model_id: &str,
    k: usize,
    min_score: f32,
) -> Result<Vec<MemoryHit>> {
    if k == 0 {
        return Ok(Vec::new());
    }

    // Load candidates: enabled, non-deleted memory items that have a stored
    // vector for the active model_id.
    let mut stmt = conn.prepare(
        "SELECT m.id, m.text, e.vec
         FROM memory_items m
         JOIN memory_embeddings e ON e.memory_id = m.id AND e.model_id = ?1
         WHERE m.enabled = 1 AND m.is_deleted = 0",
    )?;
    let rows = stmt.query_map(params![model_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Vec<u8>>(2)?,
        ))
    })?;

    let mut hits: Vec<MemoryHit> = Vec::new();
    for r in rows {
        let (memory_id, text, blob) = r?;
        let stored = blob_to_vec(&blob).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, err.into())
        })?;
        let score = cosine_unit(query_vec, &stored);
        if score.is_nan() {
            continue;
        }
        hits.push(MemoryHit {
            memory_id,
            text,
            score,
        });
    }

    // Sort descending by score, drop anything below the floor, then truncate
    // to top-k. (Filter-then-truncate and truncate-then-filter give the same
    // result here since the floor is a monotonic predicate over a sorted
    // list — this order is just the more natural read, not a correctness
    // requirement.)
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.retain(|h| h.score >= min_score);
    hits.truncate(k);

    // Retrieval-time privacy re-check: drop any hit whose contributing
    // journal_entry source currently fails the locked OR invisible predicate.
    // Built from the shared predicate fns so it can't drift from the read-side
    // visibility filter used everywhere else.
    let mut drop_stmt = conn.prepare(&privacy_drop_probe_sql())?;
    // Fail-CLOSED: a privacy/safety filter must drop on uncertainty. A DB error
    // during the lock probe would otherwise leak a locked memory's distilled
    // fact to a possibly-hosted chat provider. So:
    //   Ok(Some(())) -> a locked/invisible contributing entry exists -> DROP
    //   Ok(None)     -> no locked/invisible source found, genuinely safe -> KEEP
    //   Err(_)       -> probe failed, can't prove it's safe -> DROP (fail-closed)
    // Replacing the prior `retain` (which kept on Err) with an explicit loop so
    // the Err arm can also log the failure via `log::warn!`, matching the
    // `src/db/` house style.
    let mut survivors: Vec<MemoryHit> = Vec::with_capacity(hits.len());
    for hit in hits {
        match drop_stmt
            .query_row(params![hit.memory_id], |_| Ok::<_, rusqlite::Error>(()))
            .optional()
        {
            Ok(Some(())) => continue,        // locked/invisible source found -> drop
            Ok(None) => survivors.push(hit), // no lockable target -> keep
            Err(err) => {
                log::warn!(
                    "memory privacy re-check probe failed for memory_id={}; \
                     dropping fail-closed to avoid leaking a possibly-locked fact: {}",
                    hit.memory_id,
                    err
                );
                continue; // probe error -> drop (fail-closed)
            }
        }
    }
    Ok(survivors)
}

/// SQL for the memory privacy re-check: returns a row iff `?1`'s memory has at
/// least one `journal_entry` source that is currently deleted, locked, or
/// invisible. A row means DROP the memory.
///
/// LEFT JOIN (not INNER JOIN) so a missing `entries`/`journals` row is visible
/// to the WHERE clause as NULL rather than silently vanishing — an INNER JOIN
/// here would fail OPEN (C1 fix).
fn privacy_drop_probe_sql() -> String {
    let locked_pred = crate::db::queries::locked_entry_exclusion_predicate();
    let invisible_pred = crate::db::queries::invisible_entry_exclusion_predicate();
    format!(
        "SELECT 1
         FROM memory_item_sources s
         LEFT JOIN entries e ON e.id = s.source_id
         LEFT JOIN journals j ON j.id = e.journal_id
         WHERE s.memory_id = ?1
           AND s.source_type = 'journal_entry'
           AND (
             e.id IS NULL
             OR e.is_deleted = 1
             OR j.is_deleted = 1
             OR NOT ({locked_pred})
             OR NOT ({invisible_pred})
           )
         LIMIT 1"
    )
}

/// Keep only the memory ids whose contributing journal entries are all still
/// visible. Same fail-CLOSED contract as the retrieval-time re-check: a probe
/// error drops the id rather than risk leaking a locked fact.
///
/// Retrieval (`retrieve_top_k_memories`) has always done this; persona building
/// reads memory items through `list_memory_items`, which does NOT, so it must
/// filter through here before any text reaches a generation prompt.
pub fn retain_privacy_safe_memory_ids(conn: &Connection, ids: &[String]) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(&privacy_drop_probe_sql()) else {
        log::warn!("memory privacy re-check could not be prepared; dropping all ids fail-closed");
        return Vec::new();
    };
    let mut safe = Vec::with_capacity(ids.len());
    for id in ids {
        match stmt
            .query_row(params![id], |_| Ok::<_, rusqlite::Error>(()))
            .optional()
        {
            Ok(Some(())) => continue,
            Ok(None) => safe.push(id.clone()),
            Err(err) => {
                log::warn!(
                    "memory privacy re-check probe failed for memory_id={id}; \
                     dropping fail-closed: {err}"
                );
                continue;
            }
        }
    }
    safe
}

// ---------------------------------------------------------------------------
// memory_jobs — watermark queue
// ---------------------------------------------------------------------------

/// Per-candidate-source call a scan makes. Inserts a fresh `pending` row if
/// `(source_type, source_id)` is unseen. On conflict, the row is reset to
/// `pending` ONLY IF the incoming `content_hash` differs from the stored one
/// (content changed → re-extract): status flips to `pending`,
/// `attempt_count` resets to 0, `next_attempt_at` / `last_error` / `updated_at`
/// / `content_hash` refresh. If the hash is UNCHANGED, the row is left
/// untouched (DO NOTHING) — the source has not changed since the last
/// successful extraction, so re-queueing it would just burn a provider call.
pub fn upsert_memory_job_watermark(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    content_hash: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_jobs
            (source_type, source_id, content_hash, status, attempt_count,
             next_attempt_at, last_attempt_at, last_error, updated_at)
         VALUES (?1, ?2, ?3, 'pending', 0, ?4, NULL, NULL, ?5)
         ON CONFLICT(source_type, source_id) DO UPDATE SET
            content_hash  = CASE
                WHEN memory_jobs.content_hash = excluded.content_hash
                THEN memory_jobs.content_hash
                ELSE excluded.content_hash
            END,
            status        = CASE
                WHEN memory_jobs.content_hash = excluded.content_hash
                THEN memory_jobs.status
                ELSE 'pending'
            END,
            attempt_count = CASE
                WHEN memory_jobs.content_hash = excluded.content_hash
                THEN memory_jobs.attempt_count
                ELSE 0
            END,
            next_attempt_at = CASE
                WHEN memory_jobs.content_hash = excluded.content_hash
                THEN memory_jobs.next_attempt_at
                ELSE excluded.next_attempt_at
            END,
            last_error    = CASE
                WHEN memory_jobs.content_hash = excluded.content_hash
                THEN memory_jobs.last_error
                ELSE NULL
            END,
            updated_at    = CASE
                WHEN memory_jobs.content_hash = excluded.content_hash
                THEN memory_jobs.updated_at
                ELSE excluded.updated_at
            END",
        params![source_type, source_id, content_hash, next_attempt_at, now],
    )?;
    Ok(())
}

/// Mark a candidate source's job row `skipped` at scan time — used when the
/// asymmetric privacy gate rejects the source (invisible entry, locked entry
/// without `ai_embed_include_protected`) or the source has no gatherable text
/// (missing/deleted/empty). Unlike [`upsert_memory_job_watermark`]:
/// - This is **unconditional** — no content-hash diff comparison. A gated
///   source must never be queued for extraction, even if its content has
///   changed since the last scan.
/// - `content_hash` is cleared to the empty string. The next scan that finds
///   the source UNGATED (e.g. the entry was unlocked, or
///   `ai_embed_include_protected` was turned ON) will compute a real hash
///   that differs from `""` and flip the row to `pending` via
///   [`upsert_memory_job_watermark`]. Without this clear, a locked-then-
///   unlocked entry whose content never changed would keep matching its old
///   stored hash and stay `skipped` forever.
///
/// Used by the scan pass (T3.3) — see `commands::ai_memory::run_memory_scan`.
pub fn upsert_memory_job_skipped(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_jobs
            (source_type, source_id, content_hash, status, attempt_count,
             next_attempt_at, last_attempt_at, last_error, updated_at)
         VALUES (?1, ?2, '', 'skipped', 0, NULL, NULL, NULL, ?3)
         ON CONFLICT(source_type, source_id) DO UPDATE SET
            status        = 'skipped',
            content_hash  = '',
            updated_at    = excluded.updated_at",
        params![source_type, source_id, now],
    )?;
    Ok(())
}

/// Read the watermark row for `(source_type, source_id)`, if any. Used by
/// the scan to compare live vs. stored content_hash before deciding to
/// (re)queue.
pub fn get_memory_job(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
) -> Result<Option<MemoryJobRow>> {
    conn.query_row(
        "SELECT source_type, source_id, content_hash, status, attempt_count,
                next_attempt_at, last_attempt_at, last_error, updated_at
         FROM memory_jobs
         WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id],
        |row| {
            Ok(MemoryJobRow {
                source_type: row.get(0)?,
                source_id: row.get(1)?,
                content_hash: row.get(2)?,
                status: row.get(3)?,
                attempt_count: row.get(4)?,
                next_attempt_at: row.get(5)?,
                last_attempt_at: row.get(6)?,
                last_error: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )
    .optional()
}

/// Claim up to `limit` due jobs (`status` in `pending`/`error` and
/// `next_attempt_at` is NULL or `<= now`), recency-first (`updated_at`
/// DESC). Atomically flips the returned rows to `in_progress`, sets
/// `last_attempt_at = now`, and bumps `updated_at = now`, so a second poll
/// before the worker finishes cannot re-claim the same jobs.
///
/// Unlike [`crate::db::embeddings::claim_due_embedding_jobs`], this is NOT
/// model-scoped and does NOT join `entries`/`journals` to apply the
/// locked/invisible privacy guard at claim time. The scan already filtered
/// candidates, and the pre-processing re-check in Phase 3 plus the
/// retrieval-time re-check in [`retrieve_top_k_memories`] (T1.3) handle
/// lock changes that land after claim.
pub fn claim_due_memory_jobs(
    conn: &Connection,
    limit: usize,
    now: i64,
) -> Result<Vec<MemoryJobRow>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT source_type, source_id, content_hash, status, attempt_count,
                next_attempt_at, last_attempt_at, last_error, updated_at
         FROM memory_jobs
         WHERE status IN ('pending', 'error')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
         ORDER BY updated_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![now, limit as i64], |row| {
        Ok(MemoryJobRow {
            source_type: row.get(0)?,
            source_id: row.get(1)?,
            content_hash: row.get(2)?,
            status: row.get(3)?,
            attempt_count: row.get(4)?,
            next_attempt_at: row.get(5)?,
            last_attempt_at: row.get(6)?,
            last_error: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    let mut claimed: Vec<MemoryJobRow> = rows.collect::<Result<Vec<_>>>()?;

    for job in &mut claimed {
        conn.execute(
            "UPDATE memory_jobs
             SET status = 'in_progress', last_attempt_at = ?3, updated_at = ?3
             WHERE source_type = ?1 AND source_id = ?2",
            params![job.source_type, job.source_id, now],
        )?;
        job.status = "in_progress".to_string();
        job.last_attempt_at = Some(now);
        job.updated_at = now;
    }
    Ok(claimed)
}

/// Recover `memory_jobs` rows left stranded in `in_progress` (worker crash /
/// cancel mid-extraction before complete/fail/pause was called). Flips them
/// back to `pending` with an immediate `next_attempt_at` so the next scan /
/// claim re-attempts them. Called once on memory-worker startup. Mirrors
/// [`crate::db::embeddings::recover_stranded_in_progress_jobs`] — including
/// its unconditional (no `last_attempt_at` recency threshold) reset: there is
/// no reliable way to distinguish a crashed worker from a slow-but-live one
/// from the DB alone, and a stranded job is permanently invisible to
/// [`claim_due_memory_jobs`]'s `pending`/`error` filter otherwise, so the
/// caller runs this BEFORE starting the worker loop (no concurrent claimers
/// exist at that point). Returns the number of rows recovered.
pub fn recover_stranded_in_progress_memory_jobs(conn: &Connection, now: i64) -> Result<usize> {
    let n = conn.execute(
        "UPDATE memory_jobs
         SET status = 'pending', next_attempt_at = ?1, updated_at = ?1
         WHERE status = 'in_progress'",
        params![now],
    )?;
    Ok(n)
}

/// Mark a job `indexed` after the worker successfully extracts the memory
/// item(s) from the source.
pub fn complete_memory_job(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'indexed', last_attempt_at = ?3, updated_at = ?3
         WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id, now],
    )?;
    Ok(())
}

/// Mark a job `skipped` — used when the source is locked-without-opt-in or
/// invisible at extraction time, so the scan does not keep re-queueing it
/// on every pass.
pub fn skip_memory_job(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'skipped', last_attempt_at = ?3, updated_at = ?3
         WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id, now],
    )?;
    Ok(())
}

/// Mark a job `error` after a failed extraction attempt: records
/// `last_error`, bumps `attempt_count`, and schedules the next retry at
/// `next_attempt_at` (caller-computed using the 60/300/900/3600s backoff
/// schedule — the DB fn just stores it, mirroring
/// [`crate::db::embeddings::fail_embedding_job`]).
pub fn fail_memory_job(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    error: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'error',
             last_error = ?3,
             attempt_count = attempt_count + 1,
             next_attempt_at = ?4,
             last_attempt_at = ?5,
             updated_at = ?5
         WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id, error, next_attempt_at, now],
    )?;
    Ok(())
}

/// Mark a job `paused` after repeated failures (e.g. the local Ollama
/// endpoint is down, timing out, or returning junk). `paused` is excluded
/// from [`claim_due_memory_jobs`]'s `pending`/`error` filter, so auto-retry
/// stops; the job resumes only when a scan re-queues it via
/// [`upsert_memory_job_watermark`] after content changes, or when
/// [`reset_paused_memory_jobs_to_pending`] flips it back.
pub fn pause_memory_job(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
    error: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'paused',
             last_error = ?3,
             attempt_count = attempt_count + 1,
             last_attempt_at = ?4,
             updated_at = ?4
         WHERE source_type = ?1 AND source_id = ?2",
        params![source_type, source_id, error, now],
    )?;
    Ok(())
}

/// Reset every `paused` job back to `pending` with a fresh attempt budget
/// (`attempt_count` / `last_error` cleared). Mirrors
/// [`crate::db::embeddings::reset_paused_jobs_to_pending`]. Returns the
/// number of rows reset.
pub fn reset_paused_memory_jobs_to_pending(
    conn: &Connection,
    next_attempt_at: i64,
    now: i64,
) -> Result<usize> {
    conn.execute(
        "UPDATE memory_jobs
         SET status = 'pending',
             next_attempt_at = ?1,
             attempt_count = 0,
             last_error = NULL,
             updated_at = ?2
         WHERE status = 'paused'",
        params![next_attempt_at, now],
    )
}

// ---------------------------------------------------------------------------
// memory scan candidates — bounded recent-source windows
// ---------------------------------------------------------------------------

/// List the `limit` most-recently-updated non-deleted journal entry ids — the
/// `journal_entry` candidate set for a scan pass. Ordered by `updated_at DESC`
/// so an edit to any entry promotes it back into the scan window. The scan
/// applies the asymmetric privacy gate (invisible / locked-without-opt-in)
/// AFTER this list returns, via `gather_source_text` in
/// `commands::ai_memory`; sources the gate rejects are marked `skipped` via
/// [`upsert_memory_job_skipped`].
pub fn list_recent_memory_candidate_entry_ids(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM entries
         WHERE is_deleted = 0
         ORDER BY updated_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>>>()
}

/// List the `limit` most-recently-updated non-deleted chat session ids — the
/// `daily_chat` candidate set for a scan pass. Daily-chat sources have no
/// lockable target (no asymmetric gate applies, per plan decision 8 / "Not
/// Building"); the gather step still drops empty/missing sessions via
/// [`upsert_memory_job_skipped`].
pub fn list_recent_memory_candidate_chat_session_ids(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM chat_sessions
         WHERE is_deleted = 0
         ORDER BY updated_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>>>()
}

// ---------------------------------------------------------------------------
// Sync (Phase 6) — read-for-push + LWW merge + vector adopt-on-match
// ---------------------------------------------------------------------------

/// One stored embedding row — the read shape the sync push serializes (engine
/// maps it to `sync::metadata::SyncedMemoryVec`; db layer stays free of
/// `sync::metadata` deps). `vec` is the raw little-endian f32 blob.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEmbeddingRow {
    pub model_id: String,
    pub dim: i64,
    pub vec: Vec<u8>,
    pub content_hash: String,
    pub indexed_at: i64,
}

/// Sync push read: every memory item INCLUDING tombstones (deletes must
/// propagate so a newer `is_deleted = 1` reaches every peer). The
/// `is_deleted` flag on [`MemoryItemRow`] carries the tombstone state.
pub fn list_all_memory_items_for_sync(conn: &Connection) -> Result<Vec<MemoryItemRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, text, source_type, enabled, is_deleted, created_at, updated_at
         FROM memory_items
         ORDER BY updated_at ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let enabled: i64 = row.get(3)?;
        let is_deleted: i64 = row.get(4)?;
        Ok(MemoryItemRow {
            id: row.get(0)?,
            text: row.get(1)?,
            source_type: row.get(2)?,
            enabled: enabled != 0,
            is_deleted: is_deleted != 0,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>>>()
}

/// Sync push read: every embedding row for one memory item (a peer may carry
/// vectors written by several model ids if the user swapped slots).
pub fn list_memory_embeddings_for_memory(
    conn: &Connection,
    memory_id: &str,
) -> Result<Vec<MemoryEmbeddingRow>> {
    let mut stmt = conn.prepare(
        "SELECT model_id, dim, vec, content_hash, indexed_at
         FROM memory_embeddings
         WHERE memory_id = ?1",
    )?;
    let rows = stmt.query_map(params![memory_id], |row| {
        Ok(MemoryEmbeddingRow {
            model_id: row.get(0)?,
            dim: row.get(1)?,
            vec: row.get(2)?,
            content_hash: row.get(3)?,
            indexed_at: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>>>()
}

/// Sync pull merge: last-writer-wins on `updated_at`. Upserts the peer row
/// only when the local item is missing OR the peer's `updated_at` is strictly
/// newer (equal timestamps keep local — deterministic, avoids flapping).
/// Returns `true` when the peer row was adopted. Tombstones (`is_deleted` =
/// true) flow through the same path so a newer delete propagates over an older
/// live row.
pub fn upsert_memory_item_lww(
    conn: &Connection,
    id: &str,
    text: &str,
    source_type: &str,
    enabled: bool,
    is_deleted: bool,
    created_at: i64,
    updated_at: i64,
) -> Result<bool> {
    let local: Option<(i64, String)> = conn
        .query_row(
            "SELECT updated_at, text FROM memory_items WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let adopt = match &local {
        None => true,
        Some((local_updated_at, _)) => updated_at > *local_updated_at,
    };
    if !adopt {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO memory_items
            (id, text, source_type, enabled, is_deleted, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            text = excluded.text,
            source_type = excluded.source_type,
            enabled = excluded.enabled,
            is_deleted = excluded.is_deleted,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at",
        params![
            id,
            text,
            source_type,
            enabled as i64,
            is_deleted as i64,
            created_at,
            updated_at
        ],
    )?;
    if local.is_some_and(|(_, local_text)| local_text != text) {
        conn.execute(
            "DELETE FROM memory_embeddings WHERE memory_id = ?1",
            params![id],
        )?;
    }
    Ok(true)
}

/// Sync pull vector adopt-on-match. Upserts the peer vector ONLY when
/// `peer_model_id == local_model_id` (the writing device's slot matches this
/// device's active memory-embed slot) AND the local row is missing or older
/// (`peer_indexed_at > local_indexed_at`). A mismatched `model_id` is the
/// common case (the slot is user-configurable) and returns `false` — the item
/// arrives vector-less and the Phase 3 worker backfill re-embeds locally.
pub fn adopt_memory_embedding_if_matching(
    conn: &Connection,
    memory_id: &str,
    peer_model_id: &str,
    local_model_id: &str,
    dim: i64,
    vec: &[u8],
    content_hash: &str,
    current_content_hash: &str,
    peer_indexed_at: i64,
) -> Result<bool> {
    if peer_model_id != local_model_id || content_hash != current_content_hash {
        return Ok(false);
    }
    let local_indexed: Option<i64> = conn
        .query_row(
            "SELECT indexed_at FROM memory_embeddings
             WHERE memory_id = ?1 AND model_id = ?2",
            params![memory_id, local_model_id],
            |row| row.get(0),
        )
        .optional()?;
    let adopt = match local_indexed {
        None => true,
        Some(local) => peer_indexed_at > local,
    };
    if !adopt {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO memory_embeddings
            (memory_id, model_id, dim, vec, content_hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(memory_id, model_id) DO UPDATE SET
            dim = excluded.dim,
            vec = excluded.vec,
            content_hash = excluded.content_hash,
            indexed_at = excluded.indexed_at",
        params![
            memory_id,
            local_model_id,
            dim,
            vec,
            content_hash,
            peer_indexed_at
        ],
    )?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        schema::migrate(&conn).expect("migrate");
        conn
    }

    // --- retain_privacy_safe_memory_ids ------------------------------------

    /// `list_memory_items` has no privacy re-check, so persona building filters
    /// through this. A memory whose contributing entry has since been locked,
    /// made invisible, or deleted must be dropped before its text can reach a
    /// generation prompt.
    #[test]
    fn retain_privacy_safe_memory_ids_drops_locked_invisible_and_missing_sources() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "open", false, false);
        seed_entry(&conn, "j1", "locked", true, false);
        seed_entry(&conn, "j1", "invisible", false, true);

        for (mid, source) in [
            ("m-open", Some("open")),
            ("m-locked", Some("locked")),
            ("m-invisible", Some("invisible")),
            ("m-missing", Some("no-such-entry")),
            ("m-unsourced", None),
        ] {
            insert_memory_item(&conn, mid, "t", "journal_entry", 1).expect("insert");
            if let Some(src) = source {
                add_memory_source(&conn, mid, "journal_entry", src).expect("link");
            }
        }

        let ids: Vec<String> = [
            "m-open",
            "m-locked",
            "m-invisible",
            "m-missing",
            "m-unsourced",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let safe = retain_privacy_safe_memory_ids(&conn, &ids);

        assert!(safe.contains(&"m-open".to_string()));
        // No journal_entry source at all → nothing lockable → keep.
        assert!(safe.contains(&"m-unsourced".to_string()));
        for dropped in ["m-locked", "m-invisible", "m-missing"] {
            assert!(
                !safe.contains(&dropped.to_string()),
                "{dropped} must be dropped",
            );
        }
    }

    /// A source that becomes locked AFTER the memory was extracted must start
    /// being dropped — the probe is evaluated at read time, not at write time.
    #[test]
    fn retain_privacy_safe_memory_ids_reacts_to_a_later_lock() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false);
        insert_memory_item(&conn, "m1", "t", "journal_entry", 1).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("link");
        let ids = vec!["m1".to_string()];
        assert_eq!(retain_privacy_safe_memory_ids(&conn, &ids).len(), 1);

        set_entry_flags(&conn, "e1", true, false);
        assert!(
            retain_privacy_safe_memory_ids(&conn, &ids).is_empty(),
            "locking the source entry must drop the memory",
        );
    }

    // --- merge_memory_items (consolidation Merge op) -----------------------

    #[test]
    fn merge_unions_sources_tombstones_absorbed_and_clears_embeddings() {
        let conn = open_test_db();
        insert_memory_item(&conn, "keep", "Works as a biologist", "journal_entry", 100)
            .expect("insert");
        insert_memory_item(&conn, "dupe", "Is a marine biologist", "journal_entry", 110)
            .expect("insert");
        add_memory_source(&conn, "keep", "journal_entry", "e1").expect("source");
        add_memory_source(&conn, "dupe", "journal_entry", "e2").expect("source");
        upsert_memory_embedding(&conn, "keep", "modelA", 2, &[0.1, 0.2], "h", 120).expect("embed");

        let merged = merge_memory_items(
            &conn,
            "keep",
            &["dupe".to_string()],
            "Works as a marine biologist",
            200,
        )
        .expect("merge");
        assert!(merged);

        let items = list_memory_items(&conn).expect("list");
        assert_eq!(items.len(), 1, "absorbed item tombstoned");
        assert_eq!(items[0].id, "keep");
        assert_eq!(items[0].text, "Works as a marine biologist");

        let mut sources: Vec<String> = list_sources_for_memory(&conn, "keep")
            .expect("sources")
            .into_iter()
            .map(|s| s.source_id)
            .collect();
        sources.sort();
        assert_eq!(
            sources,
            vec!["e1".to_string(), "e2".to_string()],
            "absorbed item's source moved onto keep"
        );

        assert!(
            list_memory_embeddings_for_memory(&conn, "keep")
                .expect("embeddings")
                .is_empty(),
            "stale keep embeddings cleared (caller re-embeds)"
        );
    }

    #[test]
    fn merge_returns_false_and_writes_nothing_when_keep_is_tombstoned() {
        let conn = open_test_db();
        insert_memory_item(&conn, "keep", "a", "journal_entry", 100).expect("insert");
        insert_memory_item(&conn, "dupe", "b", "journal_entry", 110).expect("insert");
        tombstone_memory_item(&conn, "keep", 120).expect("tombstone");

        let merged =
            merge_memory_items(&conn, "keep", &["dupe".to_string()], "merged", 200).expect("merge");
        assert!(!merged);

        let items = list_memory_items(&conn).expect("list");
        assert_eq!(items.len(), 1, "absorb candidate untouched");
        assert_eq!(items[0].id, "dupe");
        assert_eq!(items[0].text, "b");
    }

    #[test]
    fn merge_skips_dead_absorb_but_merges_live_one() {
        let conn = open_test_db();
        insert_memory_item(&conn, "keep", "a", "journal_entry", 100).expect("insert");
        insert_memory_item(&conn, "live", "b", "journal_entry", 110).expect("insert");

        // One absorb id missing entirely, one live — the live one merges.
        let merged = merge_memory_items(
            &conn,
            "keep",
            &["ghost".to_string(), "live".to_string()],
            "merged",
            200,
        )
        .expect("merge");
        assert!(merged);
        let items = list_memory_items(&conn).expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "merged");

        // Every absorb id dead → false, keep text untouched.
        let merged2 = merge_memory_items(&conn, "keep", &["ghost".to_string()], "clobbered", 300)
            .expect("merge");
        assert!(!merged2);
        assert_eq!(list_memory_items(&conn).expect("list")[0].text, "merged");
    }

    #[test]
    fn update_memory_item_text_is_noop_on_tombstoned_row() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "original", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[0.1, 0.2], "h", 110).expect("embed");
        tombstone_memory_item(&conn, "m1", 120).expect("tombstone");

        // A concurrent pass tombstoned the row between the caller's liveness
        // check and this write — the update must not resurrect its text (LWW
        // would ship it back to peers) nor clear the embeddings row.
        update_memory_item_text(&conn, "m1", "rewritten after death", 200).expect("update");
        let text: String = conn
            .query_row("SELECT text FROM memory_items WHERE id = 'm1'", [], |row| {
                row.get(0)
            })
            .expect("row");
        assert_eq!(text, "original");
        assert_eq!(
            list_memory_embeddings_for_memory(&conn, "m1")
                .expect("embeddings")
                .len(),
            1,
            "embeddings untouched on the no-op path"
        );
    }

    // --- memory_items: insert + list + tombstone ---------------------------

    #[test]
    fn insert_then_list_returns_row() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "likes espresso", "journal_entry", 100).expect("insert");
        let items = list_memory_items(&conn).expect("list");
        assert_eq!(items.len(), 1);
        let row = &items[0];
        assert_eq!(row.id, "m1");
        assert_eq!(row.text, "likes espresso");
        assert_eq!(row.source_type, "journal_entry");
        assert!(row.enabled);
        assert!(!row.is_deleted);
        assert_eq!(row.created_at, 100);
        assert_eq!(row.updated_at, 100);
    }

    #[test]
    fn list_is_newest_updated_at_first() {
        let conn = open_test_db();
        insert_memory_item(&conn, "old", "a", "journal_entry", 100).expect("insert");
        insert_memory_item(&conn, "new", "b", "daily_chat", 300).expect("insert");
        insert_memory_item(&conn, "mid", "c", "journal_entry", 200).expect("insert");
        let items = list_memory_items(&conn).expect("list");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn insert_rejects_invalid_source_type() {
        let conn = open_test_db();
        let res = insert_memory_item(&conn, "m1", "t", "bogus", 1);
        assert!(res.is_err(), "invalid source_type must trip DB CHECK");
    }

    #[test]
    fn tombstone_excludes_from_list() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        tombstone_memory_item(&conn, "m1", 200).expect("tombstone");
        // Not in the (non-deleted) list.
        assert!(list_memory_items(&conn).expect("list").is_empty());
        // But the row still exists with is_deleted=1 (sync LWW needs it).
        let is_deleted: i64 = conn
            .query_row(
                "SELECT is_deleted FROM memory_items WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )
            .expect("row exists");
        assert_eq!(is_deleted, 1);
    }

    // --- memory_item_exists ------------------------------------------------

    #[test]
    fn memory_item_exists_true_for_live_false_for_missing_or_tombstoned() {
        let conn = open_test_db();
        assert!(
            !memory_item_exists(&conn, "nope").expect("exists"),
            "missing id -> false"
        );
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        assert!(
            memory_item_exists(&conn, "m1").expect("exists"),
            "live -> true"
        );
        tombstone_memory_item(&conn, "m1", 200).expect("tombstone");
        assert!(
            !memory_item_exists(&conn, "m1").expect("exists"),
            "tombstoned -> false (update/delete ops skip it)"
        );
    }

    // --- update_memory_item_text invalidates embeddings --------------------

    #[test]
    fn update_text_bumps_updated_at_and_clears_embeddings() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "v1", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[0.1, 0.2], "hash1", 110)
            .expect("upsert embed");

        // Precondition: embedding row exists.
        let count_before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = 'm1'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count_before, 1);

        update_memory_item_text(&conn, "m1", "v2-edited", 500).expect("update text");

        // Embedding wiped.
        let count_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = 'm1'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count_after, 0);

        // Text + updated_at refreshed.
        let (text, updated_at): (String, i64) = conn
            .query_row(
                "SELECT text, updated_at FROM memory_items WHERE id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("select");
        assert_eq!(text, "v2-edited");
        assert_eq!(updated_at, 500);
    }

    // --- set_memory_enabled ------------------------------------------------

    #[test]
    fn set_memory_enabled_toggles_and_bumps_updated_at() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        set_memory_enabled(&conn, "m1", false, 250).expect("disable");
        let row = &list_memory_items(&conn).expect("list")[0];
        assert!(!row.enabled);
        assert_eq!(row.updated_at, 250);

        set_memory_enabled(&conn, "m1", true, 400).expect("enable");
        let row = &list_memory_items(&conn).expect("list")[0];
        assert!(row.enabled);
        assert_eq!(row.updated_at, 400);
    }

    // --- memory_item_sources: add + list + dedupe --------------------------

    #[test]
    fn add_source_then_list() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add");
        add_memory_source(&conn, "m1", "daily_chat", "c1").expect("add");

        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert_eq!(srcs.len(), 3);
        let mut got: Vec<(String, String)> = srcs
            .iter()
            .map(|s| (s.source_type.clone(), s.source_id.clone()))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("daily_chat".to_string(), "c1".to_string()),
                ("journal_entry".to_string(), "e1".to_string()),
                ("journal_entry".to_string(), "e2".to_string()),
            ]
        );
    }

    #[test]
    fn add_source_dedupes_via_insert_or_ignore() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add");
        // Same composite key — must be a no-op, not an error.
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("re-add no-op");
        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert_eq!(srcs.len(), 1);
    }

    // --- cleanup_memory_for_deleted_entry (Bug 4 fix) ----------------------

    fn memory_item_is_deleted(conn: &Connection, id: &str) -> bool {
        let is_deleted: i64 = conn
            .query_row(
                "SELECT is_deleted FROM memory_items WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("row exists");
        is_deleted != 0
    }

    #[test]
    fn cleanup_tombstones_sole_source_memory_and_removes_source_and_job() {
        let conn = open_test_db();
        // 💡 review pass 2: seed a REAL, unlocked/visible entries row so this
        // exercises the normal "zero remaining sources" tombstone path its
        // name implies, rather than the fail-closed missing-entry branch
        // (which now ALSO tombstones, for a different reason — see
        // `cleanup_treats_missing_entries_row_as_protected_fail_closed`).
        seed_entry(&conn, "j1", "e1", false, false);
        insert_memory_item(&conn, "m1", "sole source fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("watermark");

        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 500).expect("cleanup");

        // Memory item tombstoned (not hard-deleted).
        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "sole-source memory must be tombstoned"
        );
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM memory_items WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )
            .expect("row exists");
        assert_eq!(updated_at, 500, "updated_at bumped to the cleanup time");

        // Source row gone.
        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert!(srcs.is_empty(), "source row must be deleted");

        // Job row gone.
        let job = get_memory_job(&conn, "journal_entry", "e1").expect("get");
        assert!(job.is_none(), "memory_jobs row must be deleted");
    }

    #[test]
    fn cleanup_leaves_multi_source_memory_alive_with_remaining_source() {
        let conn = open_test_db();
        // Both sources must be REAL, unlocked/visible entries rows: with the
        // fail-closed protected-probe fix, a missing entries row is now
        // treated as protected (tombstone-whole), which would otherwise
        // defeat the "survives via a remaining source" assertion below for
        // the wrong reason.
        seed_entry(&conn, "j1", "e1", false, false);
        seed_entry(&conn, "j1", "e2", false, false);
        insert_memory_item(&conn, "m1", "consolidated fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source e1");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add source e2");
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("watermark");

        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 500).expect("cleanup");

        // Still alive — e2 is a surviving source.
        assert!(
            !memory_item_is_deleted(&conn, "m1"),
            "memory with a remaining source must survive"
        );
        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert_eq!(srcs.len(), 1, "only e1's source row is removed");
        assert_eq!(srcs[0].source_id, "e2");

        // The deleted entry's OWN job row is still removed even though the
        // memory item survives.
        let job = get_memory_job(&conn, "journal_entry", "e1").expect("get");
        assert!(job.is_none(), "e1's memory_jobs row must be deleted");
    }

    #[test]
    fn cleanup_with_no_memories_for_entry_is_a_noop() {
        let conn = open_test_db();
        // Unrelated memory item + job, nothing referencing "e1".
        insert_memory_item(&conn, "m1", "unrelated", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e-other").expect("add source");

        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 500)
            .expect("cleanup is a no-op, not an error");

        assert!(
            !memory_item_is_deleted(&conn, "m1"),
            "unrelated memory untouched"
        );
        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert_eq!(srcs.len(), 1, "unrelated source untouched");
    }

    // --- cleanup: locked/invisible deleted source tombstones outright (C1) -

    #[test]
    fn cleanup_tombstones_whole_item_when_deleted_source_was_locked_even_with_surviving_source() {
        // C1 fix: entry e1 (locked) and entry e2 (unlocked) both contribute
        // to memory m1. Deleting e1 must tombstone the WHOLE item — e2
        // surviving as a source must not "launder" e1's locked contribution
        // back into retrieval, because e1's own source row is about to be
        // deleted and the retrieval-time re-check can no longer see e1 ever
        // contributed at all.
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", true, false); // LOCKED
        seed_entry(&conn, "j1", "e2", false, false); // unlocked
        insert_memory_item(&conn, "m1", "blended fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add e1");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add e2");

        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 500).expect("cleanup");

        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "memory with a locked deleted source must be tombstoned outright, \
             even with a surviving unlocked source"
        );
        // e1's source row is gone; e2's survives (untouched by this
        // cascade) — harmless since the item itself is now tombstoned.
        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert_eq!(srcs.len(), 1);
        assert_eq!(srcs[0].source_id, "e2");
    }

    #[test]
    fn cleanup_tombstones_whole_item_when_deleted_source_was_invisible() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, true); // INVISIBLE
        seed_entry(&conn, "j1", "e2", false, false);
        insert_memory_item(&conn, "m1", "blended fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add e1");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add e2");

        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 500).expect("cleanup");

        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "memory with an invisible deleted source must be tombstoned outright"
        );
    }

    /// 💡 review pass 2: the protected-probe LEFT JOIN fix — a deleted
    /// `journal_entry` source with NO `entries` row at all (already
    /// hard-removed elsewhere, or never existed) must be treated as
    /// protected (fail-closed), tombstoning the whole memory item outright
    /// even though an unrelated, genuinely-unlocked source survives. Before
    /// the fix, the INNER JOIN silently excluded the missing row from the
    /// match set (fail OPEN), leaving the item alive via the surviving
    /// source — the exact "launder a protected source" risk this cascade
    /// exists to prevent.
    #[test]
    fn cleanup_treats_missing_entries_row_as_protected_fail_closed() {
        let conn = open_test_db();
        // e1 has NO entries row at all. e2 is real, unlocked, visible, and
        // in a DIFFERENT journal (proves it isn't rescuing e1 by accident).
        seed_entry(&conn, "j2", "e2", false, false);
        insert_memory_item(&conn, "m1", "blended fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add e1 (no entries row)");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add e2");

        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 500).expect("cleanup");

        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "a deleted source with no entries row at all must be treated as \
             protected (fail-closed), tombstoning the whole item even though \
             e2 survives"
        );
    }

    // --- cleanup_memory_for_deleted_source: daily_chat (C4 fix) ------------

    #[test]
    fn cleanup_daily_chat_source_tombstones_sole_source_memory() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "sole chat fact", "daily_chat", 100).expect("insert");
        add_memory_source(&conn, "m1", "daily_chat", "session-1").expect("add source");
        upsert_memory_job_watermark(&conn, "daily_chat", "session-1", "h", 0, 100)
            .expect("watermark");

        cleanup_memory_for_deleted_source(&conn, "daily_chat", "session-1", 500).expect("cleanup");

        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "sole daily_chat-source memory must be tombstoned when its session is deleted"
        );
        let job = get_memory_job(&conn, "daily_chat", "session-1").expect("get");
        assert!(
            job.is_none(),
            "the session's memory_jobs row must be removed"
        );
    }

    #[test]
    fn cleanup_daily_chat_source_leaves_multi_source_memory_alive() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "consolidated fact", "daily_chat", 100).expect("insert");
        add_memory_source(&conn, "m1", "daily_chat", "session-1").expect("add source 1");
        add_memory_source(&conn, "m1", "daily_chat", "session-2").expect("add source 2");

        cleanup_memory_for_deleted_source(&conn, "daily_chat", "session-1", 500).expect("cleanup");

        assert!(
            !memory_item_is_deleted(&conn, "m1"),
            "memory with a surviving daily_chat source must not be tombstoned"
        );
        let srcs = list_sources_for_memory(&conn, "m1").expect("list");
        assert_eq!(srcs.len(), 1);
        assert_eq!(srcs[0].source_id, "session-2");
    }

    // --- cleanup_memory_for_entries_bulk (I9/C5 fix) ------------------------

    #[test]
    fn bulk_cleanup_scoped_to_journal_tombstones_sole_source_and_leaves_others() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false);
        seed_entry(&conn, "j1", "e2", false, false);

        // m1: sole-sourced from e1 in j1 -> must be tombstoned.
        insert_memory_item(&conn, "m1", "sole fact from e1", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add");
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("watermark");

        // m2: sourced from e2 (in j1) AND an entry outside j1 -> survives.
        insert_memory_item(&conn, "m2", "consolidated fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m2", "journal_entry", "e2").expect("add");
        add_memory_source(&conn, "m2", "journal_entry", "outside-entry").expect("add");

        cleanup_memory_for_entries_bulk(&conn, Some("j1"), 500).expect("bulk cleanup");

        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "m1's sole source (e1) was in the scoped journal -> tombstoned"
        );
        assert!(
            !memory_item_is_deleted(&conn, "m2"),
            "m2 survives via its outside-the-journal source"
        );
        let m2_srcs = list_sources_for_memory(&conn, "m2").expect("list");
        assert_eq!(m2_srcs.len(), 1);
        assert_eq!(m2_srcs[0].source_id, "outside-entry");

        // e1's job row removed; e2 never had one, no-op.
        assert!(get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .is_none());
    }

    #[test]
    fn bulk_cleanup_scoped_to_journal_tombstones_whole_item_for_locked_source_with_surviving_source(
    ) {
        // C1(a) at the bulk level: a LOCKED entry in-scope contributes to a
        // memory that ALSO has a surviving source OUTSIDE the scoped journal
        // — the whole item must still be tombstoned, not rescued.
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", true, false); // LOCKED, in scope
        seed_entry(&conn, "j2", "e2", false, false); // unlocked, OUTSIDE scope

        insert_memory_item(&conn, "m1", "blended fact", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add e1");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add e2");

        cleanup_memory_for_entries_bulk(&conn, Some("j1"), 500).expect("bulk cleanup");

        assert!(
            memory_item_is_deleted(&conn, "m1"),
            "a locked in-scope source must tombstone the whole item even with \
             an out-of-scope surviving source"
        );
    }

    #[test]
    fn bulk_cleanup_unscoped_covers_every_entry() {
        // journal_id = None -> every entry in the table, mirroring
        // hard_wipe_user_data's full-catalog wipe.
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false);
        seed_entry(&conn, "j2", "e2", false, false);

        insert_memory_item(&conn, "m1", "fact from e1", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add");
        insert_memory_item(&conn, "m2", "fact from e2", "journal_entry", 100).expect("insert");
        add_memory_source(&conn, "m2", "journal_entry", "e2").expect("add");
        insert_memory_item(&conn, "m3", "chat fact, untouched", "daily_chat", 100).expect("insert");
        add_memory_source(&conn, "m3", "daily_chat", "session-1").expect("add");

        cleanup_memory_for_entries_bulk(&conn, None, 500).expect("bulk cleanup");

        assert!(memory_item_is_deleted(&conn, "m1"));
        assert!(memory_item_is_deleted(&conn, "m2"));
        assert!(
            !memory_item_is_deleted(&conn, "m3"),
            "daily_chat-only memory is untouched by the journal_entry-scoped bulk cleanup"
        );
    }

    #[test]
    fn bulk_cleanup_empty_scope_is_a_noop() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "unrelated", "daily_chat", 100).expect("insert");
        add_memory_source(&conn, "m1", "daily_chat", "session-1").expect("add");

        cleanup_memory_for_entries_bulk(&conn, Some("no-such-journal"), 500)
            .expect("no-op, not an error");

        assert!(!memory_item_is_deleted(&conn, "m1"));
    }

    /// Regression guard (advisor-caught gap, round-2 review): a memory item
    /// that already has ZERO sources for reasons UNRELATED to this call
    /// (e.g. a peer-adopted item whose source list got filtered down —
    /// `sync::engine`'s `is_safe_id` gate can drop a short/oversize source
    /// id) must NOT be swept up by an unrelated `delete_journal` /
    /// `hard_wipe_user_data` call just because it happens to have zero
    /// sources. Only items this call actually touches (>= 1 in-scope
    /// source) may be tombstoned.
    #[test]
    fn bulk_cleanup_does_not_touch_a_preexisting_zero_source_item_outside_scope() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false);
        insert_memory_item(&conn, "m-orphan", "arrived source-less", "daily_chat", 100)
            .expect("insert");
        // No add_memory_source call at all — m-orphan has zero sources from
        // the start, unrelated to journal j1.

        cleanup_memory_for_entries_bulk(&conn, Some("j1"), 500).expect("bulk cleanup");

        assert!(
            !memory_item_is_deleted(&conn, "m-orphan"),
            "a pre-existing zero-source item outside this call's scope must survive"
        );
    }

    // --- upsert_memory_embedding: round-trip + multi-model -----------------

    #[test]
    fn upsert_embedding_round_trips_and_replaces() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 3, &[0.1, 0.2, 0.3], "h1", 110)
            .expect("upsert");

        let (dim, blob, hash, indexed_at): (i64, Vec<u8>, String, i64) = conn
            .query_row(
                "SELECT dim, vec, content_hash, indexed_at
                 FROM memory_embeddings WHERE memory_id='m1' AND model_id='modelA'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("select");
        assert_eq!(dim, 3);
        assert_eq!(blob, vec_to_blob(&[0.1, 0.2, 0.3]));
        assert_eq!(hash, "h1");
        assert_eq!(indexed_at, 110);

        // Replace in place.
        upsert_memory_embedding(&conn, "m1", "modelA", 3, &[0.9, 0.8, 0.7], "h2", 120)
            .expect("re-upsert");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings
                 WHERE memory_id='m1' AND model_id='modelA'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 1);
        let new_hash: String = conn
            .query_row(
                "SELECT content_hash FROM memory_embeddings
                 WHERE memory_id='m1' AND model_id='modelA'",
                [],
                |row| row.get(0),
            )
            .expect("select");
        assert_eq!(new_hash, "h2");
    }

    #[test]
    fn upsert_embedding_supports_multiple_models_per_item() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 1, &[0.1], "hA", 110).expect("A");
        upsert_memory_embedding(&conn, "m1", "modelB", 1, &[0.2], "hB", 120).expect("B");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id='m1'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 2);
    }

    // --- list_memory_ids_missing_embedding_for_model -----------------------

    #[test]
    fn missing_embedding_for_model_filters_correctly() {
        let conn = open_test_db();
        // m1: enabled, has embedding for modelA -> excluded.
        insert_memory_item(&conn, "m1", "t1", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 1, &[0.1], "h", 110).expect("embed");
        // m2: enabled, no embedding for modelA -> included.
        insert_memory_item(&conn, "m2", "t2", "journal_entry", 200).expect("insert");
        // m3: enabled, has embedding only for modelB (not modelA) -> included.
        insert_memory_item(&conn, "m3", "t3", "daily_chat", 300).expect("insert");
        upsert_memory_embedding(&conn, "m3", "modelB", 1, &[0.3], "h", 310).expect("embed");
        // m4: disabled -> excluded.
        insert_memory_item(&conn, "m4", "t4", "journal_entry", 400).expect("insert");
        set_memory_enabled(&conn, "m4", false, 410).expect("disable");
        // m5: soft-deleted -> excluded.
        insert_memory_item(&conn, "m5", "t5", "journal_entry", 500).expect("insert");
        tombstone_memory_item(&conn, "m5", 510).expect("tombstone");

        let mut missing =
            list_memory_ids_missing_embedding_for_model(&conn, "modelA").expect("missing");
        missing.sort();
        assert_eq!(missing, vec!["m2".to_string(), "m3".to_string()]);
    }

    // --- upsert_memory_job_watermark ---------------------------------------

    #[test]
    fn watermark_new_insert_is_pending() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "hash1", 50, 100)
            .expect("upsert");
        let job = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row present");
        assert_eq!(job.status, "pending");
        assert_eq!(job.content_hash, "hash1");
        assert_eq!(job.attempt_count, 0);
        assert_eq!(job.next_attempt_at, Some(50));
        assert!(job.last_error.is_none());
        assert!(job.last_attempt_at.is_none());
        assert_eq!(job.updated_at, 100);
    }

    #[test]
    fn watermark_unchanged_hash_is_noop() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "hash1", 50, 100)
            .expect("upsert");
        // Move it into a failed/paused state with non-default fields.
        fail_memory_job(&conn, "journal_entry", "e1", "boom", 999, 200).expect("fail");
        let after_fail = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(after_fail.status, "error");
        assert_eq!(after_fail.attempt_count, 1);

        // Re-upsert with the SAME hash — must be a complete no-op.
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "hash1", 1234, 5678)
            .expect("upsert noop");
        let untouched = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(untouched.status, "error", "status untouched");
        assert_eq!(untouched.attempt_count, 1, "attempt_count untouched");
        assert_eq!(
            untouched.next_attempt_at,
            Some(999),
            "next_attempt_at untouched"
        );
        assert_eq!(untouched.updated_at, 200, "updated_at untouched");
        assert_eq!(untouched.last_error.as_deref(), Some("boom"));
    }

    #[test]
    fn watermark_changed_hash_resets_to_pending() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "hash1", 50, 100)
            .expect("upsert");
        fail_memory_job(&conn, "journal_entry", "e1", "boom", 999, 200).expect("fail");

        // New content hash -> reset to pending, fresh attempt budget.
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "hash2", 777, 300)
            .expect("upsert reset");
        let reset = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(reset.status, "pending");
        assert_eq!(reset.content_hash, "hash2");
        assert_eq!(reset.attempt_count, 0);
        assert_eq!(reset.next_attempt_at, Some(777));
        assert!(reset.last_error.is_none());
        assert_eq!(reset.updated_at, 300);
    }

    // --- upsert_memory_job_skipped -----------------------------------------

    #[test]
    fn skipped_inserts_new_row_as_skipped_with_empty_hash() {
        let conn = open_test_db();
        upsert_memory_job_skipped(&conn, "journal_entry", "e1", 100).expect("skip");
        let job = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row present");
        assert_eq!(job.status, "skipped");
        assert_eq!(
            job.content_hash, "",
            "hash cleared so a later ungate re-queues"
        );
        assert_eq!(job.attempt_count, 0);
        assert_eq!(job.updated_at, 100);
    }

    #[test]
    fn skipped_overwrites_pending_and_clears_hash() {
        // A previously-pending row whose source later becomes gated (e.g.
        // entry locked) must flip to skipped and clear its hash — otherwise
        // an ungate with unchanged content would no-op forever.
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "realhash", 50, 100)
            .expect("upsert pending");
        let before = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(before.status, "pending");
        assert_eq!(before.content_hash, "realhash");

        upsert_memory_job_skipped(&conn, "journal_entry", "e1", 200).expect("skip");
        let after = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(after.status, "skipped");
        assert_eq!(after.content_hash, "");
        assert_eq!(after.updated_at, 200);
    }

    #[test]
    fn skipped_then_real_upsert_after_ungate_flips_to_pending() {
        // The load-bearing reason `upsert_memory_job_skipped` clears the
        // hash: a subsequent scan finding the source ungated computes a real
        // hash that differs from "" → watermark flips to pending.
        let conn = open_test_db();
        upsert_memory_job_skipped(&conn, "journal_entry", "e1", 100).expect("skip");
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "realhash", 50, 200)
            .expect("upsert after ungate");
        let after = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(after.status, "pending", "ungate + new hash re-queues");
        assert_eq!(after.content_hash, "realhash");
    }

    #[test]
    fn skipped_is_idempotent() {
        // Re-skipping a skipped row is a no-op except for updated_at.
        let conn = open_test_db();
        upsert_memory_job_skipped(&conn, "journal_entry", "e1", 100).expect("skip");
        upsert_memory_job_skipped(&conn, "journal_entry", "e1", 300).expect("skip again");
        let job = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(job.status, "skipped");
        assert_eq!(job.content_hash, "");
        assert_eq!(job.updated_at, 300);
    }

    // --- list_recent_memory_candidate_* -----------------------------------

    #[test]
    fn list_recent_entry_ids_orders_by_updated_at_desc_excludes_deleted() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at)
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("journal");
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
             VALUES ('old', 'j1', 0, 0, 100)",
            [],
        )
        .expect("old");
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
             VALUES ('new', 'j1', 0, 0, 300)",
            [],
        )
        .expect("new");
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
             VALUES ('del', 'j1', 0, 0, 999)",
            [],
        )
        .expect("seed");
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'del'", [])
            .expect("delete");

        let ids = list_recent_memory_candidate_entry_ids(&conn, 10).expect("list");
        assert_eq!(ids, vec!["new".to_string(), "old".to_string()]);
    }

    #[test]
    fn list_recent_entry_ids_respects_limit() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at)
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("journal");
        for (i, id) in ["e1", "e2", "e3"].iter().enumerate() {
            conn.execute(
                "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
                 VALUES (?1, 'j1', 0, 0, ?2)",
                params![id, i as i64],
            )
            .expect("entry");
        }
        let ids = list_recent_memory_candidate_entry_ids(&conn, 2).expect("list");
        assert_eq!(ids.len(), 2);
        // DESC ordering → e3 (updated_at=2), e2 (updated_at=1).
        assert_eq!(ids, vec!["e3".to_string(), "e2".to_string()]);
    }

    #[test]
    fn list_recent_chat_session_ids_orders_by_updated_at_desc_excludes_deleted() {
        let conn = open_test_db();
        // `persona_prompt_snapshot` is NOT NULL in the chat_sessions schema;
        // seed all three rows with a placeholder persona snapshot.
        conn.execute(
            "INSERT INTO chat_sessions
                (id, persona, persona_prompt_snapshot, language, created_at, updated_at)
             VALUES ('old', 'empathetic', '', 'en', 0, 100)",
            [],
        )
        .expect("old");
        conn.execute(
            "INSERT INTO chat_sessions
                (id, persona, persona_prompt_snapshot, language, created_at, updated_at)
             VALUES ('new', 'empathetic', '', 'en', 0, 300)",
            [],
        )
        .expect("new");
        conn.execute(
            "INSERT INTO chat_sessions
                (id, persona, persona_prompt_snapshot, language, created_at, updated_at)
             VALUES ('del', 'empathetic', '', 'en', 0, 999)",
            [],
        )
        .expect("seed");
        conn.execute(
            "UPDATE chat_sessions SET is_deleted = 1 WHERE id = 'del'",
            [],
        )
        .expect("delete");

        let ids = list_recent_memory_candidate_chat_session_ids(&conn, 10).expect("list");
        assert_eq!(ids, vec!["new".to_string(), "old".to_string()]);
    }

    // --- claim_due_memory_jobs ---------------------------------------------

    #[test]
    fn claim_due_claims_pending_and_error_due_skips_future_orders_recency() {
        let conn = open_test_db();
        // pending, due (next_attempt_at <= now) — oldest updated_at.
        upsert_memory_job_watermark(&conn, "journal_entry", "p1", "h", 0, 100).expect("up");
        // pending, due — newest updated_at (should be claimed first).
        upsert_memory_job_watermark(&conn, "journal_entry", "p2", "h", 0, 300).expect("up");
        // error, due.
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 200).expect("up");
        fail_memory_job(&conn, "journal_entry", "e1", "x", 0, 250).expect("fail");
        // error but NOT yet due (next_attempt_at in the future).
        upsert_memory_job_watermark(&conn, "journal_entry", "e2", "h", 0, 150).expect("up");
        fail_memory_job(&conn, "journal_entry", "e2", "x", 10_000, 160).expect("fail");

        let claimed = claim_due_memory_jobs(&conn, 10, 1_000).expect("claim");
        let ids: Vec<&str> = claimed.iter().map(|j| j.source_id.as_str()).collect();
        // Recency-first by updated_at DESC: p2(300) > e1(250 fail) > p1(100).
        assert_eq!(ids, vec!["p2", "e1", "p1"]);
        for j in &claimed {
            assert_eq!(j.status, "in_progress");
            assert_eq!(j.last_attempt_at, Some(1_000));
        }

        // e2 was not due -> not claimed, still 'error'.
        let e2 = get_memory_job(&conn, "journal_entry", "e2")
            .expect("get")
            .expect("row");
        assert_eq!(e2.status, "error");
    }

    #[test]
    fn claim_due_respects_null_next_attempt_at_as_due() {
        let conn = open_test_db();
        // Manually insert a row with NULL next_attempt_at (a pending row
        // freshly seeded before any backoff scheduling).
        conn.execute(
            "INSERT INTO memory_jobs (source_type, source_id, content_hash, status,
                next_attempt_at, updated_at)
             VALUES ('journal_entry', 'n1', 'h', 'pending', NULL, 100)",
            [],
        )
        .expect("insert");
        let claimed = claim_due_memory_jobs(&conn, 10, 1_000).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].source_id, "n1");
        assert_eq!(claimed[0].status, "in_progress");
    }

    #[test]
    fn claim_due_limit_zero_returns_empty() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "p1", "h", 0, 100).expect("up");
        let claimed = claim_due_memory_jobs(&conn, 0, 1_000).expect("claim");
        assert!(claimed.is_empty());
    }

    // --- complete / skip / fail / pause / reset cycle ----------------------

    #[test]
    fn complete_job_sets_indexed() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("up");
        complete_memory_job(&conn, "journal_entry", "e1", 500).expect("complete");
        let job = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(job.status, "indexed");
        assert_eq!(job.last_attempt_at, Some(500));
        assert_eq!(job.updated_at, 500);
    }

    #[test]
    fn skip_job_sets_skipped() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("up");
        skip_memory_job(&conn, "journal_entry", "e1", 500).expect("skip");
        let job = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(job.status, "skipped");
        assert_eq!(job.updated_at, 500);
    }

    #[test]
    fn fail_pause_reset_cycle() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("up");

        // Fail once.
        fail_memory_job(&conn, "journal_entry", "e1", "err1", 60, 200).expect("fail");
        let j = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(j.status, "error");
        assert_eq!(j.attempt_count, 1);
        assert_eq!(j.next_attempt_at, Some(60));
        assert_eq!(j.last_error.as_deref(), Some("err1"));
        assert_eq!(j.last_attempt_at, Some(200));

        // Pause (after repeated failures).
        pause_memory_job(&conn, "journal_entry", "e1", "giving up", 300).expect("pause");
        let j = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(j.status, "paused");
        assert_eq!(j.attempt_count, 2);
        assert_eq!(j.last_error.as_deref(), Some("giving up"));

        // A paused job is NOT claimed (excluded from pending/error filter).
        let claimed = claim_due_memory_jobs(&conn, 10, 10_000).expect("claim");
        assert!(claimed.is_empty(), "paused jobs must not be claimed");

        // Reset paused -> pending.
        let n = reset_paused_memory_jobs_to_pending(&conn, 5_000, 400).expect("reset");
        assert_eq!(n, 1);
        let j = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(j.status, "pending");
        assert_eq!(j.attempt_count, 0);
        assert_eq!(j.next_attempt_at, Some(5_000));
        assert!(j.last_error.is_none());
        assert_eq!(j.updated_at, 400);

        // Now it can be claimed again.
        let claimed = claim_due_memory_jobs(&conn, 10, 10_000).expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].source_id, "e1");
        assert_eq!(claimed[0].status, "in_progress");
    }

    #[test]
    fn reset_paused_returns_zero_when_none_paused() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("up");
        complete_memory_job(&conn, "journal_entry", "e1", 200).expect("complete");
        let n = reset_paused_memory_jobs_to_pending(&conn, 5_000, 300).expect("reset");
        assert_eq!(n, 0);
    }

    // --- retrieve_top_k_memories ------------------------------------------

    /// Seed a journal + (optionally locked/invisible) entry, returning the
    /// entry id. Mirrors the shape `embeddings.rs` tests use for entries.
    fn seed_entry(
        conn: &Connection,
        journal_id: &str,
        entry_id: &str,
        is_locked: bool,
        is_invisible: bool,
    ) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at)
             VALUES (?1, 'J', 0, 0)",
            params![journal_id],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries
                (id, journal_id, title, content_text, entry_date,
                 created_at, updated_at, is_locked, is_invisible)
             VALUES (?1, ?2, 't', 'c', 0, 0, 0, ?3, ?4)",
            params![entry_id, journal_id, is_locked as i64, is_invisible as i64],
        )
        .expect("seed entry");
    }

    /// Set the journal-level lock / invisible flag (entries inherit via the
    /// COALESCE in the predicates).
    fn set_journal_flags(conn: &Connection, journal_id: &str, is_locked: bool, is_invisible: bool) {
        conn.execute(
            "UPDATE journals SET is_locked = ?2, is_invisible = ?3 WHERE id = ?1",
            params![journal_id, is_locked as i64, is_invisible as i64],
        )
        .expect("update journal flags");
    }

    /// Set the entry-level lock / invisible flag.
    fn set_entry_flags(conn: &Connection, entry_id: &str, is_locked: bool, is_invisible: bool) {
        conn.execute(
            "UPDATE entries SET is_locked = ?2, is_invisible = ?3 WHERE id = ?1",
            params![entry_id, is_locked as i64, is_invisible as i64],
        )
        .expect("update entry flags");
    }

    #[test]
    fn retrieve_k_zero_returns_empty() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 0, -1.0).expect("retrieve");
        assert!(hits.is_empty());
    }

    #[test]
    fn retrieve_returns_top_k_by_score() {
        let conn = open_test_db();
        // Three memories with varying cosine to the query [1.0, 0.0].
        insert_memory_item(&conn, "m1", "opposite", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[-1.0, 0.0], "h", 110).expect("embed");
        insert_memory_item(&conn, "m2", "aligned", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m2", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        insert_memory_item(&conn, "m3", "orthogonal", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m3", "modelA", 2, &[0.0, 1.0], "h", 110).expect("embed");

        // k = 2 truncates and orders by score desc.
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 2, -1.0).expect("retrieve");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].memory_id, "m2");
        assert_eq!(hits[1].memory_id, "m3");
        assert!(hits[0].score > hits[1].score);
        assert_eq!(hits[0].text, "aligned");

        // k larger than the candidate set returns all (ordered).
        let all =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 10, -1.0).expect("retrieve");
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].memory_id, "m2");
        assert_eq!(all[1].memory_id, "m3"); // score 0
        assert_eq!(all[2].memory_id, "m1"); // score -1
    }

    // --- retrieve_top_k_memories: min_score floor (Bug 3 fix) --------------

    /// A query vector far from every stored item (best score ~0, well below
    /// any reasonable relevance floor) returns nothing — the "N memories
    /// used" indicator must not fire for an unrelated question.
    #[test]
    fn retrieve_with_min_score_drops_all_when_query_is_unrelated() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "aligned", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        insert_memory_item(&conn, "m2", "orthogonal", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m2", "modelA", 2, &[0.0, 1.0], "h", 110).expect("embed");

        // Query is a unit vector 45° from BOTH stored items (no exact match
        // for either) — best possible score is ~0.707, under a 0.9 floor.
        let query = [
            std::f32::consts::FRAC_1_SQRT_2,
            std::f32::consts::FRAC_1_SQRT_2,
        ];
        let hits = retrieve_top_k_memories(&conn, &query, "modelA", 5, 0.9).expect("retrieve");
        assert!(
            hits.is_empty(),
            "every candidate scores ~0.707, under a 0.9 floor — a genuinely \
             unrelated query must return nothing"
        );
    }

    /// A near-match (score above the floor) still comes back — the floor
    /// must not swallow genuinely relevant hits.
    #[test]
    fn retrieve_with_min_score_keeps_a_near_match() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "aligned", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        insert_memory_item(&conn, "m2", "opposite", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m2", "modelA", 2, &[-1.0, 0.0], "h", 110).expect("embed");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, 0.35).expect("retrieve");
        assert_eq!(
            hits.len(),
            1,
            "the aligned (score 1.0) hit clears the floor"
        );
        assert_eq!(hits[0].memory_id, "m1");
    }

    /// The floor is a parameter, not a hardcoded constant: a permissive floor
    /// (e.g. the consolidation call site's) still returns low-scoring hits —
    /// this is the trap the plan calls out (do not hardcode a threshold
    /// inside the fn, or extraction-time consolidation silently loses
    /// candidates it used to see).
    #[test]
    fn retrieve_with_permissive_min_score_preserves_prior_no_threshold_behavior() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "opposite", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[-1.0, 0.0], "h", 110).expect("embed");

        // Worst possible cosine score (-1.0) — a permissive floor must still
        // keep it, exactly like the pre-fix no-threshold behavior.
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].memory_id, "m1");
    }

    #[test]
    fn retrieve_excludes_disabled_memory() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "disabled", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        set_memory_enabled(&conn, "m1", false, 200).expect("disable");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(hits.is_empty(), "disabled memory must not be retrieved");
    }

    #[test]
    fn retrieve_excludes_deleted_memory() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "deleted", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        tombstone_memory_item(&conn, "m1", 200).expect("tombstone");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(hits.is_empty(), "tombstoned memory must not be retrieved");
    }

    #[test]
    fn retrieve_excludes_wrong_model() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "only-modelB", "daily_chat", 100).expect("insert");
        // Only an embedding for modelB exists; query for modelA -> silent empty.
        upsert_memory_embedding(&conn, "m1", "modelB", 2, &[1.0, 0.0], "h", 110).expect("embed");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory without an embedding for the active model must not be retrieved"
        );
    }

    #[test]
    fn retrieve_drops_memory_whose_entry_source_is_locked() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", true, false); // LOCKED entry
        insert_memory_item(&conn, "m1", "from locked entry", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        // Locked -> dropped.
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory sourced from a locked entry must be dropped"
        );

        // Unlock -> included again.
        set_entry_flags(&conn, "e1", false, false);
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].memory_id, "m1");
    }

    #[test]
    fn retrieve_drops_memory_whose_entry_source_is_invisible() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, true); // INVISIBLE entry
        insert_memory_item(&conn, "m1", "from invisible entry", "journal_entry", 100)
            .expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        // Invisible -> dropped.
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory sourced from an invisible entry must be dropped"
        );

        // Reveal -> included again.
        set_entry_flags(&conn, "e1", false, false);
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].memory_id, "m1");
    }

    #[test]
    fn retrieve_drops_memory_whose_journal_is_locked() {
        // Lock at the JOURNAL level — the predicate checks both entry and journal.
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false); // entry unlocked...
        set_journal_flags(&conn, "j1", true, false); // ...but journal locked
        insert_memory_item(
            &conn,
            "m1",
            "from journal-locked entry",
            "journal_entry",
            100,
        )
        .expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory sourced from a journal-locked entry must be dropped"
        );

        // Unlock the journal -> included.
        set_journal_flags(&conn, "j1", false, false);
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].memory_id, "m1");
    }

    /// 💡 review pass 2: the drop-check must also fail closed when the
    /// entry's JOURNAL is soft-deleted directly — reachable across the two
    /// independent entry/journal sync channels, where a journal's tombstone
    /// can arrive before its entries' own `is_deleted` flips locally.
    /// Checking only `e.is_deleted` missed this.
    #[test]
    fn retrieve_drops_memory_whose_entrys_journal_is_softdeleted() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false); // entry itself not deleted...
        conn.execute("UPDATE journals SET is_deleted = 1 WHERE id = 'j1'", [])
            .expect("soft-delete journal only");
        insert_memory_item(
            &conn,
            "m1",
            "from journal-deleted entry",
            "journal_entry",
            100,
        )
        .expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory sourced from an entry whose JOURNAL is soft-deleted must be \
             dropped, even though the entry row itself is not marked deleted"
        );
    }

    #[test]
    fn retrieve_keeps_memory_with_only_daily_chat_source() {
        let conn = open_test_db();
        // No journal/entry rows exist at all — the memory is sourced only from
        // daily_chat, so the lock re-check has no lockable target.
        insert_memory_item(&conn, "m1", "from chat", "daily_chat", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "daily_chat", "chat-session-42").expect("add source");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert_eq!(
            hits.len(),
            1,
            "daily-chat-only memory is never dropped by the entry re-check"
        );
        assert_eq!(hits[0].memory_id, "m1");
    }

    // --- privacy re-check: fail-closed on missing/deleted source (C1 fix) --

    /// An orphaned source row — the `journal_entry` it points at has no row
    /// in `entries` at all (e.g. a hard delete elsewhere, or a stale peer
    /// re-add per I4) — must drop the memory rather than being silently
    /// treated as "no lockable target". An INNER JOIN would fail OPEN here
    /// (no matching row = no drop candidate = kept); the LEFT JOIN fix must
    /// fail CLOSED instead.
    #[test]
    fn retrieve_drops_memory_whose_entry_source_row_is_missing_entirely() {
        let conn = open_test_db();
        // No journal/entries rows exist for "e1" at all.
        insert_memory_item(&conn, "m1", "from orphaned source", "journal_entry", 100)
            .expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "a memory whose journal_entry source row is missing entirely must be dropped, \
             not silently kept as if it had no lockable target"
        );
    }

    /// A source entry that has been soft-deleted (but was never locked or
    /// invisible) must still drop the memory — deletion alone is enough,
    /// independent of the lock/invisible flags.
    #[test]
    fn retrieve_drops_memory_whose_entry_source_is_softdeleted_but_never_locked() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false); // never locked/invisible
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e1'", [])
            .expect("soft-delete entry");
        insert_memory_item(&conn, "m1", "from softdeleted entry", "journal_entry", 100)
            .expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "a memory sourced from a soft-deleted entry must be dropped even when \
             the entry was never locked or invisible"
        );
    }

    /// I4 — a stale peer `memory.bin` union-merging a deleted entry's source
    /// row back in must NOT resurrect the memory into retrieval. Simulates
    /// the sync interaction documented on `cleanup_memory_for_deleted_source`:
    /// the cascade already ran (item survived via a second source), then a
    /// "re-add" (`add_memory_source` again, mirroring sync's union-merge)
    /// brings the deleted entry's source row back.
    #[test]
    fn retrieve_drops_memory_even_after_sync_reintroduces_deleted_source_row() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", false, false); // unlocked when deleted
        seed_entry(&conn, "j1", "e2", false, false); // surviving source
        insert_memory_item(&conn, "m1", "consolidated fact", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add e1");
        add_memory_source(&conn, "m1", "journal_entry", "e2").expect("add e2");

        // Cascade runs as part of e1's soft-delete: source row removed,
        // entry flipped to is_deleted, item survives via e2.
        cleanup_memory_for_deleted_source(&conn, "journal_entry", "e1", 300).expect("cleanup");
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e1'", [])
            .expect("soft-delete entry");
        assert!(
            !memory_item_is_deleted(&conn, "m1"),
            "precondition: item survives the cascade via e2"
        );

        // A stale peer memory.bin re-adds e1's source row (union-merge never
        // removes sources — see phase-6-sync.md).
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("re-add via sync");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "a re-added source pointing at a soft-deleted entry must still be dropped \
             by the retrieval-time fail-closed re-check (I4)"
        );
    }

    // --- privacy re-check: blend-doesn't-rescue + softdelete (I1 fix) -------
    //
    // NOTE on the missing `retrieve_drops_memory_when_lock_probe_errors` test:
    // the I1 fix changes the `Err` arm of the lock probe from fail-open (keep)
    // to fail-closed (drop). Proving that branch directly requires forcing the
    // `entries`/`journals` join inside the probe to return a rusqlite `Err`
    // (e.g. dropping the `entries` table mid-retrieve). Every clean in-memory
    // injection either (a) distorts the test by mutating the live schema other
    // tests rely on, or (b) doesn't actually trip an `Err` from the probe
    // (missing join rows come back as `Ok(None)`, not `Err`). Rather than ship
    // a distorted test, we lock in the two related guarantees the reviewer
    // flagged as the highest-value fallbacks (S3 + S4). The fail-closed branch
    // itself is a one-liner whose correctness is obvious by inspection.

    /// S3 — a memory whose contributing entry is locked is dropped regardless
    /// of the entry's `is_deleted` flag: even a soft-deleted locked entry must
    /// not leak its distilled fact.
    #[test]
    fn retrieve_drops_memory_whose_entry_is_softdeleted_and_locked() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", true, false); // LOCKED entry
                                                    // Soft-delete the entry too — the lock must still win.
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e1'", [])
            .expect("soft-delete entry");
        insert_memory_item(
            &conn,
            "m1",
            "from softdeleted locked entry",
            "journal_entry",
            100,
        )
        .expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add source");

        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory sourced from a soft-deleted-but-locked entry must still be dropped"
        );
    }

    /// S4 — the blend-doesn't-rescue guarantee. A memory backed by BOTH a
    /// locked `journal_entry` source AND a `daily_chat` source is dropped
    /// entirely: the presence of a safe (chat) source does NOT rescue a memory
    /// that also draws from a locked/invisible entry. This is the
    /// highest-value fallback test called out for the I1 fix.
    #[test]
    fn retrieve_drops_memory_with_mixed_locked_entry_and_chat_source() {
        let conn = open_test_db();
        seed_entry(&conn, "j1", "e1", true, false); // LOCKED entry source
        insert_memory_item(&conn, "m1", "blended fact", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[1.0, 0.0], "h", 110).expect("embed");
        // Two contributing sources: one locked journal_entry, one daily_chat.
        add_memory_source(&conn, "m1", "journal_entry", "e1").expect("add entry source");
        add_memory_source(&conn, "m1", "daily_chat", "chat-session-7").expect("add chat source");

        // The locked journal_entry source sinks the whole memory — the safe
        // daily_chat source does NOT rescue it.
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert!(
            hits.is_empty(),
            "memory with ANY locked/invisible journal_entry source must be dropped, \
             even when also backed by a daily_chat source"
        );

        // Unlock the entry -> the memory is now fully safe and returns.
        set_entry_flags(&conn, "e1", false, false);
        let hits =
            retrieve_top_k_memories(&conn, &[1.0, 0.0], "modelA", 5, -1.0).expect("retrieve");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].memory_id, "m1");
    }

    // --- recover_stranded_in_progress_memory_jobs (I2 fix) -----------------
    //
    // NOTE: the review brief suggested asserting a RECENT in_progress job is
    // NOT recovered (i.e. that the recovery fn has a `last_attempt_at`
    // recency threshold). The reference fn it points at
    // (`embeddings::recover_stranded_in_progress_jobs`, embeddings.rs:1021)
    // has NO such threshold — it unconditionally flips every `in_progress`
    // row to `pending`. Per the brief's "Mirror that EXACT threshold logic"
    // instruction, this fn mirrors that exactly: no threshold. So both an
    // OLD and a RECENT in_progress job are recovered; the test below asserts
    // that real behavior rather than the brief's mistaken assumption.

    #[test]
    fn recover_stranded_in_progress_memory_jobs_resets_them() {
        let conn = open_test_db();

        // Job A: stranded in_progress with an OLD last_attempt_at.
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("up");
        claim_due_memory_jobs(&conn, 10, 200).expect("claim -> in_progress");
        let a_after_claim = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(a_after_claim.status, "in_progress");
        assert_eq!(a_after_claim.last_attempt_at, Some(200));

        // Job B: stranded in_progress with a RECENT last_attempt_at. Because
        // the mirrored recovery fn has no recency threshold (matching
        // embeddings.rs), this is ALSO recovered — that is the behavior under
        // test here.
        upsert_memory_job_watermark(&conn, "journal_entry", "e2", "h", 0, 100).expect("up");
        claim_due_memory_jobs(&conn, 10, 5_000).expect("claim -> in_progress");
        let b_after_claim = get_memory_job(&conn, "journal_entry", "e2")
            .expect("get")
            .expect("row");
        assert_eq!(b_after_claim.status, "in_progress");
        assert_eq!(b_after_claim.last_attempt_at, Some(5_000));

        // Run recovery at now = 10_000.
        let n = recover_stranded_in_progress_memory_jobs(&conn, 10_000).expect("recover");
        assert_eq!(n, 2, "both stranded in_progress jobs are recovered");

        let a = get_memory_job(&conn, "journal_entry", "e1")
            .expect("get")
            .expect("row");
        assert_eq!(a.status, "pending", "old stranded job -> pending");
        assert_eq!(
            a.next_attempt_at,
            Some(10_000),
            "next_attempt_at reset to now"
        );
        assert_eq!(a.updated_at, 10_000, "updated_at bumped to now");

        let b = get_memory_job(&conn, "journal_entry", "e2")
            .expect("get")
            .expect("row");
        assert_eq!(
            b.status, "pending",
            "recent in_progress job is also recovered (no recency threshold, mirroring embeddings.rs)"
        );
        assert_eq!(b.next_attempt_at, Some(10_000));
        assert_eq!(b.updated_at, 10_000);

        // A non-stranded (pending) job is untouched by recovery, and a
        // completed (indexed) job is NOT reset.
        upsert_memory_job_watermark(&conn, "journal_entry", "e3", "h", 0, 100).expect("up");
        complete_memory_job(&conn, "journal_entry", "e3", 300).expect("complete");
        let n2 = recover_stranded_in_progress_memory_jobs(&conn, 20_000).expect("recover");
        assert_eq!(n2, 0, "no in_progress rows left to recover");
        let e3 = get_memory_job(&conn, "journal_entry", "e3")
            .expect("get")
            .expect("row");
        assert_eq!(e3.status, "indexed", "indexed job survives recovery");
    }

    #[test]
    fn recover_stranded_returns_zero_when_none_in_progress() {
        let conn = open_test_db();
        upsert_memory_job_watermark(&conn, "journal_entry", "e1", "h", 0, 100).expect("up");
        // Still pending — nothing stranded.
        let n = recover_stranded_in_progress_memory_jobs(&conn, 1_000).expect("recover");
        assert_eq!(n, 0);
    }

    // --- Phase 6 sync helpers --------------------------------------------

    #[test]
    fn list_all_memory_items_for_sync_includes_tombstones() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "live", "journal_entry", 100).expect("insert");
        insert_memory_item(&conn, "m2", "gone", "journal_entry", 100).expect("insert");
        tombstone_memory_item(&conn, "m2", 200).expect("tombstone");

        let all = list_all_memory_items_for_sync(&conn).expect("list all");
        assert_eq!(all.len(), 2, "tombstones included for delete propagation");
        let tombstoned = all.iter().find(|r| r.id == "m2").expect("m2 present");
        assert!(tombstoned.is_deleted);
    }

    #[test]
    fn upsert_memory_item_lww_adopts_newer_skips_older_and_missing() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "local", "journal_entry", 100).expect("insert");

        // Peer newer → adopted.
        let adopted = upsert_memory_item_lww(
            &conn,
            "m1",
            "peer-new",
            "journal_entry",
            true,
            false,
            50,
            200,
        )
        .expect("lww");
        assert!(adopted);
        assert_eq!(list_memory_items(&conn).expect("list")[0].text, "peer-new");

        // Peer older → skipped (local 200 stays).
        let adopted = upsert_memory_item_lww(
            &conn,
            "m1",
            "peer-stale",
            "journal_entry",
            true,
            false,
            50,
            150,
        )
        .expect("lww");
        assert!(!adopted);
        assert_eq!(list_memory_items(&conn).expect("list")[0].text, "peer-new");

        // Equal timestamp → keep local (no flap).
        let adopted = upsert_memory_item_lww(
            &conn,
            "m1",
            "peer-eq",
            "journal_entry",
            true,
            false,
            50,
            200,
        )
        .expect("lww");
        assert!(!adopted);

        // Missing local item → adopted.
        let adopted =
            upsert_memory_item_lww(&conn, "m9", "fresh", "daily_chat", true, false, 10, 20)
                .expect("lww");
        assert!(adopted);
    }

    #[test]
    fn upsert_memory_item_lww_propagates_newer_tombstone() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "live", "journal_entry", 100).expect("insert");
        // Peer tombstone newer → local item tombstoned.
        let adopted =
            upsert_memory_item_lww(&conn, "m1", "live", "journal_entry", true, true, 50, 200)
                .expect("lww");
        assert!(adopted);
        assert!(
            list_all_memory_items_for_sync(&conn).expect("all")[0].is_deleted,
            "newer tombstone overwrites older live row"
        );
    }

    #[test]
    fn upsert_memory_item_lww_replacing_text_removes_stale_embeddings() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "old text", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "local:model", 1, &[0.5], "old-hash", 110)
            .expect("seed vector");

        assert!(upsert_memory_item_lww(
            &conn,
            "m1",
            "new text",
            "journal_entry",
            true,
            false,
            100,
            200,
        )
        .expect("lww"));

        assert!(
            list_memory_embeddings_for_memory(&conn, "m1")
                .expect("embeddings")
                .is_empty(),
            "a newer text winner must invalidate vectors for the old text"
        );
    }

    #[test]
    fn adopt_memory_embedding_model_mismatch_returns_false() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        let adopted = adopt_memory_embedding_if_matching(
            &conn,
            "m1",
            "foreign-model",
            "local-model",
            2,
            &[0u8; 8],
            "h",
            "h",
            110,
        )
        .expect("adopt");
        assert!(!adopted, "foreign model_id vector dropped");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 0, "no row written");
    }

    #[test]
    fn adopt_memory_embedding_matching_adopts_newer_skips_older() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        // No local row → adopt.
        let adopted = adopt_memory_embedding_if_matching(
            &conn, "m1", "local", "local", 2, &[1u8; 8], "h1", "h1", 110,
        )
        .expect("adopt");
        assert!(adopted);
        // Local now 110; peer older 50 → skip.
        let adopted = adopt_memory_embedding_if_matching(
            &conn, "m1", "local", "local", 2, &[2u8; 8], "h2", "h1", 50,
        )
        .expect("adopt");
        assert!(!adopted);
        // Peer newer 200 → adopt.
        let adopted = adopt_memory_embedding_if_matching(
            &conn, "m1", "local", "local", 2, &[3u8; 8], "h3", "h3", 200,
        )
        .expect("adopt");
        assert!(adopted);
        let hashes: Vec<String> = conn
            .prepare("SELECT content_hash FROM memory_embeddings WHERE memory_id = 'm1'")
            .expect("prepare")
            .query_map([], |r| r.get::<_, String>(0))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect");
        assert_eq!(hashes, vec!["h3".to_string()]);
    }

    #[test]
    fn list_memory_embeddings_for_memory_returns_all_models() {
        let conn = open_test_db();
        insert_memory_item(&conn, "m1", "t", "journal_entry", 100).expect("insert");
        upsert_memory_embedding(&conn, "m1", "modelA", 2, &[0.1, 0.2], "hA", 110).expect("A");
        upsert_memory_embedding(&conn, "m1", "modelB", 2, &[0.3, 0.4], "hB", 120).expect("B");
        let rows = list_memory_embeddings_for_memory(&conn, "m1").expect("list");
        assert_eq!(rows.len(), 2, "both model_id rows returned for push");
    }
}
