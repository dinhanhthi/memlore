//! Database queries for the embedding chunk store (`entry_embedding_chunks`)
//! and the per-entry embedding dirty queue (`entry_embedding_jobs`).
//!
//! Vectors are stored as little-endian f32 bytes. Round-tripping through
//! [`vec_to_blob`] / [`blob_to_vec`] is the only allowed encoding — never
//! cast `&[f32]` directly to bytes (alignment + endianness pitfalls).
//!
//! `entry_embedding_chunks.content_hash` is position-independent (hash of
//! the normalized chunk text, see `ai::chunking::Chunk`). Callers that need
//! to know which chunks changed after a re-chunk MUST compare content_hash
//! values across the whole stored set (see [`list_stored_chunks`]), never
//! hash-at-the-same-chunk_index — a mid-entry paragraph insert shifts every
//! later chunk_index without changing the unaffected chunks' hashes, and a
//! positional compare would force a full, unnecessary re-embed.

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Result};

use crate::db::filters::SearchFilters;
use crate::db::queries::LockedView;

/// Encode a vector as the little-endian f32 byte sequence stored in the
/// `vec` BLOB column.
pub fn vec_to_blob(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for f in vec {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Decode the little-endian f32 byte sequence stored in the `vec` BLOB
/// column back to a `Vec<f32>`. Returns an error if `bytes.len()` is not a
/// multiple of 4.
pub fn blob_to_vec(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!(
            "embedding blob length must be a multiple of 4, got {}",
            bytes.len()
        ));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

/// One cosine-ranked retrieval hit for chat RAG — the
/// *best-scoring chunk* for its entry, after grouping (see
/// [`retrieve_top_k`]).
#[derive(Debug, Clone, PartialEq)]
pub struct RetrievalHit {
    pub entry_id: String,
    pub score: f32,
    pub chunk_index: i64,
    /// Embed-time snapshot, used as a Phase-2 diff/debug aid only — NEVER
    /// render it as user-facing text; it can be stale after edits (stored
    /// chunks are intentionally not wiped on edit, see module docs).
    pub preview: Option<String>,
    pub char_start: i64,
    pub char_end: i64,
    /// The stored chunk's `content_hash` at embed time — position-independent,
    /// so callers can match this hit against a freshly re-chunked entry's
    /// current chunks (see `ai::chunking::Chunk::content_hash`) even after
    /// the entry has been edited and re-chunked.
    pub content_hash: String,
}

/// Cosine similarity for L2-unit vectors. Returns 0 when lengths disagree.
pub(crate) fn cosine_unit(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut acc = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        acc += x * y;
    }
    acc
}

/// Return the top-`k` entries ranked by cosine similarity against
/// `query_vec` for the active `model_id`. Scores every stored chunk, then
/// groups by `entry_id` keeping each entry's single best-scoring chunk —
/// an entry with N chunks must occupy exactly one slot in the result, not
/// up to N. Skips NaN scores defensively.
///
/// Returns UNFILTERED chunks — callers MUST apply locked/invisible
/// visibility filtering (see `fetch_entry_meta_with_locks` / `is_locked`
/// guards) before returning results or feeding a provider. Do NOT add a
/// caller that skips this.
pub fn retrieve_top_k(
    conn: &Connection,
    query_vec: &[f32],
    model_id: &str,
    k: usize,
) -> Result<Vec<RetrievalHit>> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let candidates = list_vectors_for_model(conn, model_id)?;
    Ok(score_group_and_truncate(candidates, query_vec, k))
}

/// Like [`retrieve_top_k`], but scores only chunks whose owning entry's
/// `entry_date` falls in `[from_ts, to_ts)` — start inclusive, end
/// exclusive, matching `db::queries::list_entries_with_content_for_date_range`.
///
/// The date filter is applied INSIDE the candidate query (a SQL join against
/// `entries` constrained by `entry_date`), not by post-filtering
/// [`retrieve_top_k`]'s output — a global top-k can easily contain zero
/// entries from the requested period, which would make a period-scoped
/// request silently return nothing instead of the in-range hits it exists
/// to find.
///
/// Returns UNFILTERED chunks — callers MUST apply locked/invisible
/// visibility filtering before returning results or feeding a provider,
/// same as [`retrieve_top_k`].
pub fn retrieve_top_k_in_range(
    conn: &Connection,
    query_vec: &[f32],
    model_id: &str,
    k: usize,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<RetrievalHit>> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let candidates = list_vectors_for_model_in_range(conn, model_id, from_ts, to_ts)?;
    Ok(score_group_and_truncate(candidates, query_vec, k))
}

/// Shared cosine / group-by-entry / sort / truncate scoring loop used by
/// both [`retrieve_top_k`] and [`retrieve_top_k_in_range`] — kept as one
/// implementation so the two entry points can't drift out of sync.
fn score_group_and_truncate(
    candidates: Vec<ChunkVector>,
    query_vec: &[f32],
    k: usize,
) -> Vec<RetrievalHit> {
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut best_per_entry: std::collections::HashMap<String, RetrievalHit> =
        std::collections::HashMap::new();
    for c in candidates {
        let score = cosine_unit(query_vec, &c.vec);
        if score.is_nan() {
            continue;
        }
        best_per_entry
            .entry(c.entry_id.clone())
            .and_modify(|existing| {
                if score > existing.score {
                    existing.score = score;
                    existing.chunk_index = c.chunk_index;
                    existing.preview = c.preview.clone();
                    existing.char_start = c.char_start;
                    existing.char_end = c.char_end;
                    existing.content_hash = c.content_hash.clone();
                }
            })
            .or_insert_with(|| RetrievalHit {
                entry_id: c.entry_id.clone(),
                score,
                chunk_index: c.chunk_index,
                preview: c.preview.clone(),
                char_start: c.char_start,
                char_end: c.char_end,
                content_hash: c.content_hash.clone(),
            });
    }

    let mut hits: Vec<RetrievalHit> = best_per_entry.into_values().collect();
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(k);
    hits
}

/// One raw chunk candidate for cosine ranking — enough metadata to group
/// hits by entry after scoring.
#[derive(Debug, Clone)]
pub struct ChunkVector {
    pub entry_id: String,
    pub chunk_index: i64,
    /// Embed-time snapshot, used as a Phase-2 diff/debug aid only — NEVER
    /// render it as user-facing text; it can be stale after edits (stored
    /// chunks are intentionally not wiped on edit, see module docs).
    /// Search snippets must be built from live `content_text` instead
    /// (see `commands::search::semantic_search_rank`).
    pub preview: Option<String>,
    pub char_start: i64,
    pub char_end: i64,
    pub vec: Vec<f32>,
    /// Position-independent hash of this stored chunk's core text — see
    /// [`RetrievalHit::content_hash`].
    pub content_hash: String,
}

/// Every stored chunk row (with metadata) for non-deleted entries under
/// `model_id`. Used by both [`retrieve_top_k`] and semantic search's
/// first-pass cosine ranking — an entry with N chunks appears N times;
/// callers group by `entry_id` after scoring, keeping the best chunk.
///
/// Returns `Vec<ChunkVector>` — at typical journal sizes (<10k entries ×
/// 768 dims × 4 bytes ≈ 30 MB) this fits comfortably in memory. A4 marks
/// an in-memory cache + cold-path streaming as a v1.0 follow-up when
/// corpus sizes exceed 50k entries.
///
/// Returns UNFILTERED chunks — callers MUST apply locked/invisible
/// visibility filtering (see `fetch_entry_meta_with_locks` / `is_locked`
/// guards) before returning results or feeding a provider. Do NOT add a
/// caller that skips this.
pub fn list_vectors_for_model(conn: &Connection, model_id: &str) -> Result<Vec<ChunkVector>> {
    let mut stmt = conn.prepare(
        "SELECT ec.entry_id, ec.chunk_index, ec.preview, ec.char_start, ec.char_end, ec.vec,
                ec.content_hash
         FROM entry_embedding_chunks ec
         JOIN entries e ON e.id = ec.entry_id
         WHERE ec.model_id = ?1
           AND e.is_deleted = 0",
    )?;
    let rows = stmt.query_map(params![model_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Vec<u8>>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let mut out: Vec<ChunkVector> = Vec::new();
    for r in rows {
        let (entry_id, chunk_index, preview, char_start, char_end, blob, content_hash) = r?;
        let vec = blob_to_vec(&blob).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, e.into())
        })?;
        out.push(ChunkVector {
            entry_id,
            chunk_index,
            preview,
            char_start,
            char_end,
            vec,
            content_hash,
        });
    }
    Ok(out)
}

/// Like [`list_vectors_for_model`], but additionally joins to `entries` and
/// constrains `entries.entry_date >= from_ts AND entries.entry_date < to_ts`
/// — start inclusive, end exclusive, matching
/// `db::queries::list_entries_with_content_for_date_range`. Backs
/// [`retrieve_top_k_in_range`]; the constraint runs inside this query so a
/// period-scoped caller never has to filter a global candidate set after
/// the fact.
///
/// Returns UNFILTERED chunks — callers MUST apply locked/invisible
/// visibility filtering before returning results or feeding a provider, same
/// as [`list_vectors_for_model`].
fn list_vectors_for_model_in_range(
    conn: &Connection,
    model_id: &str,
    from_ts: i64,
    to_ts: i64,
) -> Result<Vec<ChunkVector>> {
    let mut stmt = conn.prepare(
        "SELECT ec.entry_id, ec.chunk_index, ec.preview, ec.char_start, ec.char_end, ec.vec,
                ec.content_hash
         FROM entry_embedding_chunks ec
         JOIN entries e ON e.id = ec.entry_id
         WHERE ec.model_id = ?1
           AND e.is_deleted = 0
           AND e.entry_date >= ?2
           AND e.entry_date < ?3",
    )?;
    let rows = stmt.query_map(params![model_id, from_ts, to_ts], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Vec<u8>>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let mut out: Vec<ChunkVector> = Vec::new();
    for r in rows {
        let (entry_id, chunk_index, preview, char_start, char_end, blob, content_hash) = r?;
        let vec = blob_to_vec(&blob).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, e.into())
        })?;
        out.push(ChunkVector {
            entry_id,
            chunk_index,
            preview,
            char_start,
            char_end,
            vec,
            content_hash,
        });
    }
    Ok(out)
}

/// Element-wise mean of N equal-length vectors — collapses an entry's
/// per-chunk vectors into one representative vector for comparisons that
/// operate at whole-entry granularity (emotion-suggestion cosine ranking
/// against the prototype vectors). Returns `None` for empty input. The
/// result is a **raw mean, not renormalized** — chunk vectors are
/// individually L2-unit (the `Embedder` trait guarantees this) but their
/// mean generally isn't; callers that need a unit vector for cosine
/// comparison must normalize the result themselves.
pub fn mean_pool_vectors(vectors: &[Vec<f32>]) -> Option<Vec<f32>> {
    let dim = vectors.first()?.len();
    let mut sum = vec![0.0f32; dim];
    let mut count = 0usize;
    for v in vectors {
        if v.len() != dim {
            continue;
        }
        for (s, x) in sum.iter_mut().zip(v.iter()) {
            *s += x;
        }
        count += 1;
    }
    if count == 0 {
        return None;
    }
    for s in sum.iter_mut() {
        *s /= count as f32;
    }
    Some(sum)
}

/// Count of distinct non-deleted entries that have at least one chunk row
/// for `model_id`. Feeds `EmbeddingIndexStats.indexed` in the Settings →
/// AI panel. Applies the same skip/protected eligibility scope as
/// [`count_total_entries_for_model`] so `indexed` is always a subset of
/// `total` — otherwise an entry with chunks that later becomes
/// locked/invisible (or gets a fresh `skipped` job) would count in
/// `indexed` but not `total`, producing an impossible "Indexed N / total
/// M" with N > M.
pub fn count_indexed_entries_for_model(
    conn: &Connection,
    model_id: &str,
    include_protected: bool,
) -> Result<u64> {
    let mut sql = String::from(
        "SELECT COUNT(DISTINCT ec.entry_id)
         FROM entry_embedding_chunks ec
         JOIN entries e ON e.id = ec.entry_id
         JOIN journals j ON j.id = e.journal_id
         WHERE ec.model_id = ?1 AND e.is_deleted = 0
           AND NOT EXISTS (
               SELECT 1 FROM entry_embedding_jobs ej
               WHERE ej.entry_id = e.id AND ej.model_id = ?1
                 AND ej.status = 'skipped'
                 AND ej.updated_at >= e.updated_at
           )
           AND ",
    );
    // Invisible exclusion is unconditional — mirrors
    // `list_entries_needing_index` (see the comment there): chunk rows are
    // deliberately kept when an entry becomes invisible, so without this an
    // embedded-then-hidden entry would inflate `indexed` past `total`.
    sql.push_str(crate::db::queries::invisible_entry_exclusion_predicate());
    if !include_protected {
        sql.push_str(" AND ");
        sql.push_str(crate::db::queries::locked_entry_exclusion_predicate());
    }
    let n: i64 = conn.query_row(&sql, params![model_id], |row| row.get(0))?;
    Ok(n as u64)
}

/// Count of distinct entries eligible for indexing under `model_id`, i.e.
/// the denominator of the "Indexed N / total" row in the Embedding settings
/// tab. Mirrors the eligibility scope of [`list_entries_needing_index`]
/// (deleted=0, latest `entry_embedding_jobs` row not `skipped`, plus the
/// caller-resolved protected-entry filter) but WITHOUT the staleness clause,
/// so a stale-but-chunked entry is counted exactly once here — not once in
/// `pending` and again in `count_indexed_entries_for_model`. This is the
/// fix for the cosmetic double-count documented in `docs/LATER.md`.
pub fn count_total_entries_for_model(
    conn: &Connection,
    model_id: &str,
    include_protected: bool,
) -> Result<u64> {
    let mut sql = String::from(
        "SELECT COUNT(*)
         FROM entries e
         JOIN journals j ON j.id = e.journal_id
         WHERE e.is_deleted = 0
           AND NOT EXISTS (
               SELECT 1 FROM entry_embedding_jobs ej
               WHERE ej.entry_id = e.id AND ej.model_id = ?1
                 AND ej.status = 'skipped'
                 AND ej.updated_at >= e.updated_at
           )
           AND ",
    );
    // Invisible exclusion is unconditional — mirrors
    // `list_entries_needing_index` (see the comment there): an invisible
    // entry can never be indexed, so counting it into the denominator would
    // make "Indexed N / total" unreachable by construction.
    sql.push_str(crate::db::queries::invisible_entry_exclusion_predicate());
    if !include_protected {
        sql.push_str(" AND ");
        sql.push_str(crate::db::queries::locked_entry_exclusion_predicate());
    }
    let n: i64 = conn.query_row(&sql, params![model_id], |row| row.get(0))?;
    Ok(n as u64)
}

/// Delete every chunk row for a given `model_id`. Useful when the user
/// changes their selected embedding model and we want to reclaim space, or
/// forces a full re-index.
pub fn delete_chunks_for_model(conn: &Connection, model_id: &str) -> Result<usize> {
    conn.execute(
        "DELETE FROM entry_embedding_chunks WHERE model_id = ?1",
        params![model_id],
    )
}

/// Delete every chunk row whose `model_id` does NOT start with
/// `keep_model_id_prefix` (matched via `LIKE '{prefix}%'`). Used by the
/// ai_v2 migration to drop orphan rows left behind by a provider/model
/// that is no longer active, keeping only the currently-configured
/// provider's rows.
pub fn delete_chunks_for_other_models(
    conn: &Connection,
    keep_model_id_prefix: &str,
) -> Result<usize> {
    let pattern = format!("{keep_model_id_prefix}%");
    conn.execute(
        "DELETE FROM entry_embedding_chunks WHERE model_id NOT LIKE ?1",
        params![pattern],
    )
}

/// Drop the semantic index for entries that have just been tombstoned.
///
/// `journal_id`: `Some(id)` scopes to every entry in one journal (the journal
/// delete cascade), `None` requires `entry_id` (a single entry delete).
///
/// **Why this is needed at all:** both tables declare
/// `REFERENCES entries(id) ON DELETE CASCADE`, but entries are only ever
/// SOFT-deleted (`is_deleted = 1`) — the row is never removed, so the FK
/// cascade never fires and the vectors would live in the encrypted DB forever.
/// Every read path already joins `entries` and filters `e.is_deleted = 0`, so
/// they are not retrievable and `list_chunks_for_sync_push` keeps them out of
/// the cloud — but they are still content derived from an entry the user
/// deleted, which is exactly the standard `cleanup_memory_for_entries_bulk`
/// exists to enforce for distilled memory.
///
/// Two statements regardless of journal size (the I9 lesson: no per-entry
/// loops inside the global-connection transaction).
///
/// Safe against resurrection: if a concurrent newer edit wins LWW and revives
/// the entry, `list_entries_needing_index` sees no chunk rows for it
/// (`NOT EXISTS`) and re-indexes from scratch.
///
/// TODO(later): an `in_progress` job dropped here can still finish on the
/// indexer thread and `upsert_chunk` the entry's vectors back. Harmless today
/// (every read path filters `e.is_deleted = 0`) but it re-creates what this
/// just cleaned — see docs/LATER.md.
pub fn delete_index_for_deleted_entries(
    conn: &Connection,
    journal_id: Option<&str>,
    entry_id: Option<&str>,
) -> Result<()> {
    let (chunks_sql, jobs_sql, param): (&str, &str, &str) = match (journal_id, entry_id) {
        (Some(jid), None) => (
            "DELETE FROM entry_embedding_chunks \
             WHERE entry_id IN (SELECT id FROM entries WHERE journal_id = ?1)",
            "DELETE FROM entry_embedding_jobs \
             WHERE entry_id IN (SELECT id FROM entries WHERE journal_id = ?1)",
            jid,
        ),
        // Explicit: a caller passing BOTH must not silently get a journal-wide
        // wipe when it meant "this entry, in this journal".
        (Some(_), Some(_)) => {
            return Err(rusqlite::Error::InvalidParameterName(
                "delete_index_for_deleted_entries: pass journal_id OR entry_id, not both".into(),
            ))
        }
        (None, Some(eid)) => (
            "DELETE FROM entry_embedding_chunks WHERE entry_id = ?1",
            "DELETE FROM entry_embedding_jobs WHERE entry_id = ?1",
            eid,
        ),
        (None, None) => return Ok(()),
    };
    conn.execute(chunks_sql, params![param])?;
    conn.execute(jobs_sql, params![param])?;
    Ok(())
}

/// Delete every chunk row, regardless of `model_id`. Used by the ai_v2
/// migration when no provider is configured — every row is orphaned.
pub fn delete_all_chunks(conn: &Connection) -> Result<usize> {
    conn.execute("DELETE FROM entry_embedding_chunks", [])
}

/// Metadata for a search hit, fetched in the second pass of semantic
/// search after top-K ids are known. Returned in input-id order.
#[derive(Debug, Clone)]
pub struct EntryMeta {
    pub entry_id: String,
    pub title: Option<String>,
    pub content_text: Option<String>,
    pub entry_date: i64,
}

/// Look up `(title, content_text, entry_date)` for a list of entry ids,
/// optionally narrowed by `filters`. Soft-deleted entries are excluded so
/// the second pass can't resurrect an entry that was deleted between the two
/// passes. Filters only _narrow_ the candidate set — the result order still
/// matches the input ordering, and missing ids are silently skipped.
pub fn fetch_entry_meta(
    conn: &Connection,
    entry_ids: &[String],
    filters: Option<&SearchFilters>,
) -> Result<Vec<EntryMeta>> {
    // Revealed → no second-lock exclusion, preserving this wrapper's prior
    // behavior (it never filtered locked entries).
    fetch_entry_meta_with_locks(conn, entry_ids, filters, LockedView::Revealed, None)
}

pub fn fetch_entry_meta_with_locks(
    conn: &Connection,
    entry_ids: &[String],
    filters: Option<&SearchFilters>,
    locked_view: LockedView,
    active_vault_id: Option<&str>,
) -> Result<Vec<EntryMeta>> {
    if entry_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Build a dynamic SQL string so filter clauses can be appended.
    // The `entries` table is aliased as `e` so that `append_filter_clauses`
    // (which emits `AND e.<col> ...` segments) works correctly.
    let mut sql = String::from(
        "SELECT e.id, e.title, e.content_text, e.entry_date \
         FROM entries e \
         JOIN journals j ON j.id = e.journal_id \
         WHERE e.is_deleted = 0 AND e.id IN (",
    );
    crate::db::queries::push_placeholders(&mut sql, entry_ids.len());
    sql.push(')');

    let mut params: Vec<Value> = entry_ids.iter().map(|id| Value::Text(id.clone())).collect();

    // Second-lock exclusion mirrors keyword search: Covered is treated as
    // Hidden (excluded), so a redacted locked entry can't leak "you have a
    // locked entry similar to X" through semantic ranking. Only Revealed
    // surfaces locked entries.
    if matches!(locked_view, LockedView::Hidden | LockedView::Covered) {
        sql.push_str(" AND ");
        sql.push_str(crate::db::queries::locked_entry_exclusion_predicate());
    }
    sql.push_str(&crate::db::queries::invisible_entry_filter(active_vault_id));

    if let Some(f) = filters.filter(|f| !f.is_empty()) {
        crate::db::queries::append_filter_clauses(&mut sql, &mut params, f);
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        Ok(EntryMeta {
            entry_id: row.get(0)?,
            title: row.get(1)?,
            content_text: row.get(2)?,
            entry_date: row.get(3)?,
        })
    })?;
    let mut found: std::collections::HashMap<String, EntryMeta> = std::collections::HashMap::new();
    for r in rows {
        let m = r?;
        found.insert(m.entry_id.clone(), m);
    }
    // Preserve input ordering, dropping ids that no longer match (or were
    // filtered out).
    Ok(entry_ids.iter().filter_map(|id| found.remove(id)).collect())
}

// ── Chunk store (`entry_embedding_chunks`) ──────────────────────────────────

/// One stored chunk row for an `(entry_id, model_id)` pair.
///
/// `content_hash` is position-independent — match chunks across a re-chunk
/// by `content_hash`, never by `chunk_index` (see module docs).
#[derive(Debug, Clone, PartialEq)]
pub struct StoredChunk {
    pub chunk_index: i64,
    pub content_hash: String,
    pub char_start: i64,
    pub char_end: i64,
    /// Embed-time snapshot, used as a Phase-2 diff/debug aid only — NEVER
    /// render it as user-facing text; it can be stale after edits (stored
    /// chunks are intentionally not wiped on edit, see module docs).
    pub preview: Option<String>,
    pub dim: usize,
    pub vec: Vec<f32>,
    pub indexed_at: i64,
}

/// Insert or replace one chunk row, keyed by `(entry_id, model_id,
/// chunk_index)`.
#[allow(clippy::too_many_arguments)]
pub fn upsert_chunk(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    chunk_index: i64,
    content_hash: &str,
    char_start: i64,
    char_end: i64,
    preview: Option<&str>,
    dim: usize,
    vec: &[f32],
    indexed_at: i64,
) -> Result<()> {
    let blob = vec_to_blob(vec);
    conn.execute(
        "INSERT INTO entry_embedding_chunks
            (entry_id, model_id, chunk_index, content_hash, char_start,
             char_end, preview, dim, vec, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(entry_id, model_id, chunk_index) DO UPDATE SET
             content_hash = excluded.content_hash,
             char_start = excluded.char_start,
             char_end = excluded.char_end,
             preview = excluded.preview,
             dim = excluded.dim,
             vec = excluded.vec,
             indexed_at = excluded.indexed_at",
        params![
            entry_id,
            model_id,
            chunk_index,
            content_hash,
            char_start,
            char_end,
            preview,
            dim as i64,
            blob,
            indexed_at
        ],
    )?;
    Ok(())
}

/// Current chunk rows for `(entry_id, model_id)`, ordered by `chunk_index`.
///
/// Callers (the Phase 2 embedding worker) match a freshly re-chunked entry
/// against this set by `content_hash`, so unchanged chunks are never
/// re-embedded even if their `chunk_index` moved.
///
/// Returns UNFILTERED chunks — callers MUST apply locked/invisible
/// visibility filtering (see `fetch_entry_meta_with_locks` / `is_locked`
/// guards) before returning results or feeding a provider. Do NOT add a
/// caller that skips this.
pub fn list_stored_chunks(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
) -> Result<Vec<StoredChunk>> {
    let mut stmt = conn.prepare(
        "SELECT chunk_index, content_hash, char_start, char_end, preview,
                dim, vec, indexed_at
         FROM entry_embedding_chunks
         WHERE entry_id = ?1 AND model_id = ?2
         ORDER BY chunk_index ASC",
    )?;
    let rows = stmt.query_map(params![entry_id, model_id], |row| {
        let chunk_index: i64 = row.get(0)?;
        let content_hash: String = row.get(1)?;
        let char_start: i64 = row.get(2)?;
        let char_end: i64 = row.get(3)?;
        let preview: Option<String> = row.get(4)?;
        let dim: i64 = row.get(5)?;
        let blob: Vec<u8> = row.get(6)?;
        let indexed_at: i64 = row.get(7)?;
        Ok((
            chunk_index,
            content_hash,
            char_start,
            char_end,
            preview,
            dim as usize,
            blob,
            indexed_at,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (chunk_index, content_hash, char_start, char_end, preview, dim, blob, indexed_at) = r?;
        let vec = blob_to_vec(&blob).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, e.into())
        })?;
        out.push(StoredChunk {
            chunk_index,
            content_hash,
            char_start,
            char_end,
            preview,
            dim,
            vec,
            indexed_at,
        });
    }
    Ok(out)
}

/// Delete chunk rows for `(entry_id, model_id)` whose `chunk_index` is not
/// in `keep_indices`. Used after a re-chunk to drop chunks that no longer
/// exist (entry shrank / a chunk merged into a neighbor). An empty
/// `keep_indices` deletes every chunk for the entry+model.
pub fn delete_chunks_not_in(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    keep_indices: &[i64],
) -> Result<usize> {
    if keep_indices.is_empty() {
        return conn.execute(
            "DELETE FROM entry_embedding_chunks WHERE entry_id = ?1 AND model_id = ?2",
            params![entry_id, model_id],
        );
    }
    let mut sql = String::from(
        "DELETE FROM entry_embedding_chunks \
         WHERE entry_id = ? AND model_id = ? AND chunk_index NOT IN (",
    );
    crate::db::queries::push_placeholders(&mut sql, keep_indices.len());
    sql.push(')');

    let mut p: Vec<Value> = vec![
        Value::Text(entry_id.to_string()),
        Value::Text(model_id.to_string()),
    ];
    p.extend(keep_indices.iter().map(|i| Value::Integer(*i)));
    conn.execute(&sql, params_from_iter(p.iter()))
}

// ── Dirty queue (`entry_embedding_jobs`) ────────────────────────────────────

/// One row from the `entry_embedding_jobs` dirty queue.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingJobRow {
    pub entry_id: String,
    pub model_id: String,
    pub content_hash: String,
    pub status: String,
    pub dirty_at: i64,
    pub next_attempt_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

/// Upsert the single dirty-queue row for `(entry_id, model_id)`: repeated
/// calls (e.g. rapid autosave edits) keep exactly one row, refreshing
/// `content_hash`/`dirty_at`/`next_attempt_at`, resetting `status` back to
/// `pending`, and clearing any prior `last_error`/`attempt_count` — a new
/// edit deserves a fresh attempt budget rather than inheriting stale
/// backoff state from content that no longer exists.
pub fn mark_entry_embedding_dirty(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    content_hash: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO entry_embedding_jobs
            (entry_id, model_id, content_hash, status, dirty_at,
             next_attempt_at, last_attempt_at, attempt_count, last_error,
             updated_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, ?5, NULL, 0, NULL, ?4)
         ON CONFLICT(entry_id, model_id) DO UPDATE SET
             content_hash = excluded.content_hash,
             status = 'pending',
             dirty_at = excluded.dirty_at,
             next_attempt_at = excluded.next_attempt_at,
             attempt_count = 0,
             last_error = NULL,
             updated_at = excluded.dirty_at",
        params![entry_id, model_id, content_hash, now, next_attempt_at],
    )?;
    Ok(())
}

/// Read the single dirty-queue row for `(entry_id, model_id)`, if any.
/// Used by the Phase 2 Task 3 opportunistic worker pass to check whether an
/// entry already has a job tracked (e.g. a not-yet-due debounce from a
/// recent edit) before seeding it as "never touched" — an entry mid-quiet-
/// window must keep waiting its own debounce, not get yanked forward just
/// because it also happens to have zero stored chunks yet.
pub fn get_embedding_job(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
) -> Result<Option<EmbeddingJobRow>> {
    conn.query_row(
        "SELECT entry_id, model_id, content_hash, status, dirty_at,
                next_attempt_at, last_attempt_at, attempt_count,
                last_error, updated_at
         FROM entry_embedding_jobs
         WHERE entry_id = ?1 AND model_id = ?2",
        params![entry_id, model_id],
        |row| {
            Ok(EmbeddingJobRow {
                entry_id: row.get(0)?,
                model_id: row.get(1)?,
                content_hash: row.get(2)?,
                status: row.get(3)?,
                dirty_at: row.get(4)?,
                next_attempt_at: row.get(5)?,
                last_attempt_at: row.get(6)?,
                attempt_count: row.get(7)?,
                last_error: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .optional()
}

/// Claim up to `limit` due jobs (`status` in `pending`/`error` and
/// `next_attempt_at <= now`) for `model_id`, recency-first — ordered by the
/// owning entry's `updated_at` (newest edited entries first), then by
/// `dirty_at` as a tiebreaker. Soft-deleted entries are excluded (mirrors
/// every other query in this file) so a job left behind by a since-deleted
/// entry never burns a provider call. Claiming atomically flips the
/// returned rows' `status` to `in_progress` (and bumps
/// `last_attempt_at`/`updated_at`) so a second poll before the worker
/// finishes doesn't re-claim the same jobs — the Phase 2 worker recovers
/// any `in_progress` rows left stranded by a cancel or crash on startup
/// via [`recover_stranded_in_progress_jobs`] (Task 5).
///
/// **Task 6 privacy boundary (C2):** mirrors the exact asymmetry
/// `list_entries_needing_index` applies on the write side — INVISIBLE
/// entries are ALWAYS excluded (regardless of `include_protected`); LOCKED
/// entries are excluded UNLESS `include_protected` is `true`. This is the
/// claim-time layer of the guard; the pre-embed re-check in
/// `ai::indexer::plan_chunk_diff` is the hardened guarantee that also
/// catches a lock landing AFTER claim but BEFORE the embed call.
pub fn claim_due_embedding_jobs(
    conn: &Connection,
    model_id: &str,
    limit: usize,
    now: i64,
    include_protected: bool,
) -> Result<Vec<EmbeddingJobRow>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut sql = String::from(
        "SELECT job.entry_id, job.model_id, job.content_hash, job.status, job.dirty_at,
                job.next_attempt_at, job.last_attempt_at, job.attempt_count,
                job.last_error, job.updated_at
         FROM entry_embedding_jobs job
         JOIN entries e ON e.id = job.entry_id
         JOIN journals j ON j.id = e.journal_id
         WHERE job.model_id = ?1
           AND e.is_deleted = 0
           AND job.status IN ('pending', 'error')
           AND job.next_attempt_at IS NOT NULL
           AND job.next_attempt_at <= ?2
           AND ",
    );
    sql.push_str(crate::db::queries::invisible_entry_exclusion_predicate());
    if !include_protected {
        sql.push_str(" AND ");
        sql.push_str(crate::db::queries::locked_entry_exclusion_predicate());
    }
    sql.push_str(" ORDER BY e.updated_at DESC, job.dirty_at DESC LIMIT ?3");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![model_id, now, limit as i64], |row| {
        Ok(EmbeddingJobRow {
            entry_id: row.get(0)?,
            model_id: row.get(1)?,
            content_hash: row.get(2)?,
            status: row.get(3)?,
            dirty_at: row.get(4)?,
            next_attempt_at: row.get(5)?,
            last_attempt_at: row.get(6)?,
            attempt_count: row.get(7)?,
            last_error: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;
    let mut claimed: Vec<EmbeddingJobRow> = rows.collect::<Result<Vec<_>>>()?;

    for job in &mut claimed {
        conn.execute(
            "UPDATE entry_embedding_jobs
             SET status = 'in_progress', last_attempt_at = ?3, updated_at = ?3
             WHERE entry_id = ?1 AND model_id = ?2",
            params![job.entry_id, job.model_id, now],
        )?;
        job.status = "in_progress".to_string();
        job.last_attempt_at = Some(now);
        job.updated_at = now;
    }
    Ok(claimed)
}

/// Mark a job `indexed` after the worker successfully embeds all of an
/// entry's chunks.
pub fn complete_embedding_job(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'indexed', last_attempt_at = ?3, updated_at = ?3
         WHERE entry_id = ?1 AND model_id = ?2",
        params![entry_id, model_id, now],
    )?;
    Ok(())
}

/// Mark a job `skipped` (e.g. entry below the min-chars threshold, or
/// excluded by the locked/invisible write-side gate).
pub fn skip_embedding_job(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'skipped', last_attempt_at = ?3, updated_at = ?3
         WHERE entry_id = ?1 AND model_id = ?2",
        params![entry_id, model_id, now],
    )?;
    Ok(())
}

/// Mark a job `error` after a failed embed attempt: records `last_error`,
/// bumps `attempt_count`, and schedules the next retry at
/// `next_attempt_at`.
pub fn fail_embedding_job(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    error: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'error',
             last_error = ?3,
             attempt_count = attempt_count + 1,
             next_attempt_at = ?4,
             last_attempt_at = ?5,
             updated_at = ?5
         WHERE entry_id = ?1 AND model_id = ?2",
        params![entry_id, model_id, error, next_attempt_at, now],
    )?;
    Ok(())
}

/// Mark a job `paused` after an auth/config-class embed error (bad/expired
/// API key, unconfigured or unsupported provider) — these never succeed on
/// bare retry, so auto-retry stops: `paused` is excluded from
/// `claim_due_embedding_jobs`'s `pending`/`error` filter, unlike `error`
/// jobs which keep retrying on their backoff schedule. The job resumes
/// only when the entry is dirtied again (`mark_entry_embedding_dirty`
/// resets `status` to `pending`) — typically once the user fixes the
/// provider and the next save (or a future explicit re-queue path) marks
/// it dirty again.
pub fn pause_embedding_job(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    error: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'paused',
             last_error = ?3,
             attempt_count = attempt_count + 1,
             last_attempt_at = ?4,
             updated_at = ?4
         WHERE entry_id = ?1 AND model_id = ?2",
        params![entry_id, model_id, error, now],
    )?;
    Ok(())
}

/// Reset every `paused` job for `model_id` back to `pending` — the C7 fix's
/// credential/config recovery trigger. `paused` jobs are deliberately
/// excluded from `claim_due_embedding_jobs`'s `pending`/`error` filter
/// (see [`pause_embedding_job`]) because auto-retrying a bad key or an
/// unconfigured provider forever is pointless; but that also means nothing
/// ever brought them back once the user actually fixed the problem —
/// `mark_entry_embedding_dirty` only fires on a NEW edit, and opportunistic
/// seeding (`ai::indexer::seed_dirty_job_if_untracked`) skips any entry that
/// already has a job row, paused or not. Callers invoke this exactly when
/// the user just supplied fresh credentials/config for `model_id` (embedding
/// slot save) or finished downloading an on-device model that was
/// previously `ModelNotReady` — see call sites in `commands::ai_provider`.
///
/// `attempt_count`/`last_error` are cleared (fresh start), mirroring
/// `mark_entry_embedding_dirty`'s "the entry is dirtied again" recovery
/// path — unlike [`reset_all_jobs_for_model_to_pending`], which resets
/// EVERY status (including already-healthy `indexed` rows) and therefore
/// leaves attempt history untouched by design. Returns the number of rows
/// reset.
pub fn reset_paused_jobs_to_pending(
    conn: &Connection,
    model_id: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<usize> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'pending',
             next_attempt_at = ?2,
             attempt_count = 0,
             last_error = NULL,
             updated_at = ?3
         WHERE model_id = ?1 AND status = 'paused'",
        params![model_id, next_attempt_at, now],
    )
}

/// "Index now" unstick pass (2026-08-04 fix, see `docs/LATER.md` →
/// "Embedding indexer — an entry can get permanently stuck as `pending`"):
/// reset EVERY not-yet-finished job row for `model_id` — anything that is
/// neither `indexed` (re-embedding those is force/Rebuild's job) nor
/// `in_progress` (actively embedding right now) — back to `pending`,
/// immediately due.
///
/// Broader than [`reset_paused_jobs_to_pending`] on purpose: an explicit
/// "Index now" click means *don't wait*, so this also pulls forward rows
/// that are merely deferred (`pending`/`error` waiting out a debounce or
/// backoff window) and rescues every dead-end state a row can reach —
/// `paused` (auth/config failure, never auto-retried), stale `skipped`
/// (entry edited after the skip without the save hook re-dirtying it, e.g.
/// a sync-applied edit), and a corrupt/far-future `next_attempt_at`.
/// Re-claiming a fresh `skipped` row is harmless: locked/deleted entries
/// are excluded by `claim_due_embedding_jobs`'s JOIN, and a below-min-chars
/// entry re-skips before any provider call.
///
/// `attempt_count`/`last_error` are cleared (fresh start), mirroring
/// [`reset_paused_jobs_to_pending`]. Returns the number of rows reset —
/// note this counts by job row with no `entries` join, so rows whose entry
/// is deleted/invisible (never claimable) are included in the count; it's a
/// log-only figure, don't surface it in UI as "N will be indexed".
pub fn reset_unfinished_jobs_to_pending(
    conn: &Connection,
    model_id: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<usize> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'pending',
             next_attempt_at = ?2,
             attempt_count = 0,
             last_error = NULL,
             updated_at = ?3
         WHERE model_id = ?1 AND status NOT IN ('indexed', 'in_progress')",
        params![model_id, next_attempt_at, now],
    )
}

/// Reset a job back to `pending` with a fresh `content_hash` and
/// `next_attempt_at` — used for manual retry / re-queue paths (e.g. a user
/// re-enabling a paused feature) and by [`crate::ai::indexer::finish_claimed_job`]'s
/// race guards (Phase 2 Task 5): when a job's embedded results are discarded
/// because the entry changed mid-embed, the row is reset with the LATEST
/// hash so the next claim's diff starts from up-to-date bookkeeping instead
/// of the stale hash the discarded attempt was planned against.
pub fn reset_embedding_job_to_pending(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    content_hash: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'pending', content_hash = ?3, next_attempt_at = ?4, updated_at = ?5
         WHERE entry_id = ?1 AND model_id = ?2",
        params![entry_id, model_id, content_hash, next_attempt_at, now],
    )?;
    Ok(())
}

/// Reset every job stranded `in_progress` back to `pending` with an
/// immediate `next_attempt_at` (Phase 2 Task 5). `in_progress` is a
/// transient claimed-but-not-yet-finished state; a row can only be left
/// there by a worker tick that claimed it and then never called back into
/// [`complete_embedding_job`] / [`fail_embedding_job`] / [`pause_embedding_job`] /
/// [`reset_embedding_job_to_pending`] — e.g. the tick observed a cancel
/// (embedding-provider swap, `pause_backfill`, app lock) mid-embed and broke
/// out of its loop, or the app crashed. Called once when the continuous
/// worker starts (`commands::ai::run_backfill_loop`) so a stranded row is
/// never permanently stuck outside `claim_due_embedding_jobs`'s
/// `pending`/`error` filter. Returns the number of rows recovered.
pub fn recover_stranded_in_progress_jobs(conn: &Connection, now: i64) -> Result<usize> {
    let n = conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'pending', next_attempt_at = ?1, updated_at = ?1
         WHERE status = 'in_progress'",
        params![now],
    )?;
    Ok(n)
}

/// Reset EVERY job row for `model_id` back to `pending` with an immediate
/// `next_attempt_at`, regardless of current status (`indexed`, `skipped`,
/// `error`, `paused`, or already `pending`) — the force-reindex counterpart
/// to [`recover_stranded_in_progress_jobs`] (C3 fix).
///
/// `start_backfill`'s `force=true` path wipes every chunk row for
/// `model_id` via [`delete_chunks_for_model`] but, without this, leaves
/// `entry_embedding_jobs` rows sitting at `status = 'indexed'` — a status
/// [`claim_due_embedding_jobs`] never selects — while
/// `seed_dirty_job_if_untracked` (the opportunistic-seeding path) also
/// bails on any entry that already has a job row, regardless of status.
/// The result: 0 chunks and 0 claimable job, forever. Calling this in the
/// SAME flow as the wipe makes every previously-indexed entry claimable
/// again on the very next tick.
///
/// `content_hash` is left untouched — the entry's content hasn't changed,
/// only the stored vectors were wiped, so the next claim's diff still
/// starts from accurate bookkeeping. Returns the number of rows reset.
pub fn reset_all_jobs_for_model_to_pending(
    conn: &Connection,
    model_id: &str,
    next_attempt_at: i64,
    now: i64,
) -> Result<usize> {
    conn.execute(
        "UPDATE entry_embedding_jobs
         SET status = 'pending', next_attempt_at = ?2, updated_at = ?3
         WHERE model_id = ?1",
        params![model_id, next_attempt_at, now],
    )
}

/// Job counts by status for `model_id`. Feeds the future indexing-status UI
/// (Phase 2+).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmbeddingIndexStats {
    pub pending: i64,
    pub in_progress: i64,
    pub indexed: i64,
    pub skipped: i64,
    pub error: i64,
    pub paused: i64,
}

pub fn list_embedding_index_stats(
    conn: &Connection,
    model_id: &str,
) -> Result<EmbeddingIndexStats> {
    let mut stmt = conn.prepare(
        "SELECT status, COUNT(*) FROM entry_embedding_jobs WHERE model_id = ?1 GROUP BY status",
    )?;
    let rows = stmt.query_map(params![model_id], |row| {
        let status: String = row.get(0)?;
        let n: i64 = row.get(1)?;
        Ok((status, n))
    })?;
    let mut stats = EmbeddingIndexStats::default();
    for r in rows {
        let (status, n) = r?;
        match status.as_str() {
            "pending" => stats.pending = n,
            "in_progress" => stats.in_progress = n,
            "indexed" => stats.indexed = n,
            "skipped" => stats.skipped = n,
            "error" => stats.error = n,
            "paused" => stats.paused = n,
            _ => {}
        }
    }
    Ok(stats)
}

/// Entry ids (non-deleted) that need (re-)indexing for `model_id` — either
/// no chunk row exists yet, OR the entry was edited after its existing
/// chunk rows for `model_id` were written — newest-edited first, up to
/// `limit`. Feeds opportunistic backfill (Phase 2) and the manual backfill
/// command.
///
/// **C11 fix — staleness, not just existence:** the original query was a
/// bare `NOT EXISTS` anti-join, so an entry that already had SOME chunk
/// rows for `model_id` was excluded forever, even if the entry's content
/// changed since those rows were written (e.g. switch embedding model A →
/// B, edit the entry, index under B, switch back to A — A's pre-edit
/// chunks still exist, so the entry was never re-embedded and retrieval
/// kept serving stale A vectors). The `e.updated_at > MAX(indexed_at)`
/// clause below closes that gap with a cheap timestamp comparison instead
/// of re-hashing content here. A false positive (`updated_at` bumped by a
/// non-text mutation, e.g. emotion/location, that didn't actually change
/// the canonical indexable text) is harmless and cheap when the re-queued
/// job resolves through the normal EMBED/REUSE path: `plan_chunk_diff`
/// finds zero changed chunks, reuses everything at zero provider cost, and
/// `write_chunk_diff` re-upserts every reused chunk with a fresh
/// `indexed_at` regardless, so the staleness condition clears after that
/// one no-op pass.
///
/// **Skip-path fix (resolves the C11 follow-up in `docs/later/`):** the
/// staleness self-heal above does NOT apply to the SKIP path
/// (`skip_embedding_job` — below `AI_ENTRY_EMBED_MIN_CHARS`, or locked with
/// `include_protected` off), since skip never calls `write_chunk_diff`. Two
/// different fixes close the two skip causes:
/// - **Below `AI_ENTRY_EMBED_MIN_CHARS`:** the skip resolution
///   (`ai::indexer`'s `claim_and_plan_batch` / `index_claimed_job`) now
///   prunes the entry's stale chunk rows via `delete_chunks_not_in(..., &[])`
///   as part of the skip — zero provider cost, and it stops retrieval from
///   serving pre-edit vectors for a now-tiny entry. Pruning alone would just
///   move the entry from the staleness branch to the bare `NOT EXISTS`
///   branch below and keep it listed forever anyway (a chunk-less entry
///   always satisfies `NOT EXISTS`), so this query ALSO excludes an entry
///   whose latest job row for `model_id` is `skipped` with no edit since
///   (`ej.updated_at >= e.updated_at` — the skip resolution is at least as
///   recent as the entry's last edit). This mirrors
///   `seed_dirty_job_if_untracked`'s "indexed is the one exception" shape,
///   but on the read side, scoped to `skipped`. A genuinely too-short entry
///   is skipped once, then excluded until either (a) it's edited again
///   (bumping `e.updated_at` past the skip's `ej.updated_at`, which also
///   only happens via a save-path edit that crosses back over
///   `AI_ENTRY_EMBED_MIN_CHARS` — see `commands::entries::
///   maybe_mark_entry_embedding_dirty_after_save`, which itself resets the
///   job to `pending` directly whenever the edited text is long enough
///   again, independent of this query), or (b) it becomes stale for an
///   unrelated reason that still has stored chunks (not applicable here,
///   since chunks were pruned).
/// - **Locked with `include_protected` off:** no query change was needed —
///   `locked_entry_exclusion_predicate()` below is evaluated against the
///   entry's CURRENT lock state on every call (not a cached/stale flag), so
///   a currently-locked entry is already excluded regardless of staleness,
///   and reappears immediately once unlocked (or `include_protected` turns
///   on) since the staleness clause is unaffected by locking. The new
///   `skipped`-job exclusion above does not interfere: it's conditioned on
///   `ej.updated_at >= e.updated_at`, so bumping `e.updated_at` on unlock (or
///   any subsequent edit) lifts it independently of lock state. Chunk rows
///   are deliberately KEPT (never pruned) on a locked-excluded skip — this
///   is documented design (see
///   `docs/plans/2026-07-06-embedding-cost-guardrails/embedding-lifecycle.md`),
///   the read-side lock filter is the guarantee, not deletion.
///
/// `include_protected` mirrors `ai_embed_include_protected`: the caller
/// resolves the setting and passes the resulting bool (same convention as
/// `LockedView`/`active_vault_id` on [`fetch_entry_meta_with_locks`]) so
/// this function stays a pure DB query. `false` (default) also excludes
/// locked entries; `true` grants write-eligibility to locked entries ONLY.
/// Invisible entries are excluded UNCONDITIONALLY — the downstream embed
/// step (`get_entry_for_provider`) and `claim_due_embedding_jobs` both
/// hard-block them regardless of this flag, so surfacing them here would
/// count entries nothing can ever drain (the exact `pending: 1`-forever
/// bug fixed 2026-08-04).
pub fn list_entries_needing_index(
    conn: &Connection,
    model_id: &str,
    limit: usize,
    include_protected: bool,
) -> Result<Vec<String>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut sql = String::from(
        "SELECT e.id
         FROM entries e
         JOIN journals j ON j.id = e.journal_id
         WHERE e.is_deleted = 0
           AND (
               NOT EXISTS (
                   SELECT 1 FROM entry_embedding_chunks ec
                   WHERE ec.entry_id = e.id AND ec.model_id = ?1
               )
               OR e.updated_at > (
                   SELECT MAX(ec2.indexed_at) FROM entry_embedding_chunks ec2
                   WHERE ec2.entry_id = e.id AND ec2.model_id = ?1
               )
           )
           AND NOT EXISTS (
               SELECT 1 FROM entry_embedding_jobs ej
               WHERE ej.entry_id = e.id AND ej.model_id = ?1
                 AND ej.status = 'skipped'
                 AND ej.updated_at >= e.updated_at
           )
           AND ",
    );
    // Invisible exclusion is UNCONDITIONAL (2026-08-04 fix): every
    // write-side consumer hard-blocks invisible entries regardless of
    // `include_protected` (`claim_due_embedding_jobs`, the opportunistic
    // seeder via `get_entry_for_provider`), so listing one here made it
    // count as "needing index" while nothing could ever drain it —
    // `pending: 1` forever in the UI. Same pattern as
    // `list_chunks_for_sync_push`.
    sql.push_str(crate::db::queries::invisible_entry_exclusion_predicate());
    if !include_protected {
        sql.push_str(" AND ");
        sql.push_str(crate::db::queries::locked_entry_exclusion_predicate());
    }
    sql.push_str(" ORDER BY e.updated_at DESC LIMIT ?2");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![model_id, limit as i64], |row| {
        row.get::<_, String>(0)
    })?;
    rows.collect()
}

// ── Cross-device sync push (Phase 5 Task 2) ─────────────────────────────────

/// One chunk row eligible for cross-device sync push.
///
/// Field shape mirrors `sync::embedding_sync::EmbeddingChunkVector`
/// intentionally — this is the DB-layer half of that struct; `db::embeddings`
/// stays free of any `sync` module dependency, and `SyncEngine::push_embedding_chunks`
/// maps this 1:1 into the sync payload type before encrypting. Never carries
/// any `entry_embedding_jobs` field (status/attempts/last_error/...) — see
/// [`list_chunks_for_sync_push`]'s doc comment.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncableChunkVector {
    pub entry_id: String,
    pub model_id: String,
    pub chunk_index: i64,
    pub content_hash: String,
    pub dim: i64,
    pub vec: Vec<u8>,
}

/// Chunk rows for `model_id` eligible for cross-device sync push.
///
/// Reads ONLY `entry_embedding_chunks` — the transient `entry_embedding_jobs`
/// dirty queue never syncs (see `sync::embedding_sync` module docs).
///
/// `include_protected` mirrors `ai_embed_include_protected` and is applied
/// with the exact same ASYMMETRIC gating shape `claim_due_embedding_jobs`
/// uses: INVISIBLE entries are ALWAYS excluded regardless of
/// `include_protected` (they are never sync-eligible — the write side never
/// embeds them either, per the project's "invisible is a hard-never"
/// convention). LOCKED entries are excluded UNLESS `include_protected` is
/// `true`, in which case their vectors sync encrypted like any other row
/// (the ciphertext is meaningless without the sync key held by this
/// device's paired peers, so this is the same trust boundary every other
/// synced row already crosses).
pub fn list_chunks_for_sync_push(
    conn: &Connection,
    model_id: &str,
    include_protected: bool,
) -> Result<Vec<SyncableChunkVector>> {
    let mut sql = String::from(
        "SELECT ec.entry_id, ec.model_id, ec.chunk_index, ec.content_hash, ec.dim, ec.vec
         FROM entry_embedding_chunks ec
         JOIN entries e ON e.id = ec.entry_id
         JOIN journals j ON j.id = e.journal_id
         WHERE ec.model_id = ?1 AND e.is_deleted = 0 AND ",
    );
    sql.push_str(crate::db::queries::invisible_entry_exclusion_predicate());
    if !include_protected {
        sql.push_str(" AND ");
        sql.push_str(crate::db::queries::locked_entry_exclusion_predicate());
    }
    sql.push_str(" ORDER BY ec.entry_id ASC, ec.chunk_index ASC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![model_id], |row| {
        Ok(SyncableChunkVector {
            entry_id: row.get(0)?,
            model_id: row.get(1)?,
            chunk_index: row.get(2)?,
            content_hash: row.get(3)?,
            dim: row.get(4)?,
            vec: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// Distinct `model_id` values currently present in the chunk store.
///
/// A model swap prunes the previous model's rows elsewhere
/// (`delete_chunks_for_model` / `delete_chunks_for_other_models`), so in
/// steady state this returns at most one id — the active embedding model.
/// The sync push path (`SyncEngine::push_embedding_chunks`) uses this to
/// discover which model(s) to push without `sync::engine` needing to
/// depend on the AI provider registry just to resolve the active model id.
pub fn distinct_synced_model_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT model_id FROM entry_embedding_chunks ORDER BY model_id")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

// ── Cross-device sync pull + adopt-on-match (Phase 5 Task 3) ───────────────

/// Max plausible embedding dimensionality — defense-in-depth bound on
/// untrusted `EmbeddingChunkVector.dim` from a peer device. Every provider
/// in this app's matrix tops out well under this (OpenAI
/// `text-embedding-3-large` is 3072-dim; on-device `fastembed` models are
/// 384-1024-dim); 8192 is generous headroom so no legitimate vector is ever
/// rejected while still bounding a hostile/corrupt payload.
const MAX_PLAUSIBLE_DIM: i64 = 8192;

/// One incoming synced chunk vector considered for cross-device adoption.
///
/// Field shape mirrors `sync::embedding_sync::EmbeddingChunkVector`
/// intentionally — same rationale as [`SyncableChunkVector`] above:
/// `db::embeddings` stays free of a `sync` module dependency, and
/// `SyncEngine::pull_embedding_chunks` maps 1:1 into this type (from an
/// already-decrypted, already-deserialized batch) before calling
/// [`adopt_synced_chunk_vector`]. Every field is UNTRUSTED peer input —
/// validated inside that function, never upserted blind.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingChunkVector {
    pub entry_id: String,
    pub model_id: String,
    pub chunk_index: i64,
    pub content_hash: String,
    pub dim: i64,
    pub vec: Vec<u8>,
}

/// Outcome of attempting to adopt one incoming synced chunk vector — see
/// [`adopt_synced_chunk_vector`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdoptOutcome {
    /// Stored via [`upsert_chunk`] — either newly, or re-writing a chunk
    /// that already held this exact `(content_hash, vec)` pair (idempotent
    /// in effect: the values written are unchanged).
    Adopted,
    /// The caller's `is_active_model` check failed: `incoming.model_id`
    /// isn't the embedding model this device has configured. Dead weight for
    /// a model this device isn't embedding with — never stored. (The
    /// no-slot-configured case never reaches here: `pull_embedding_chunks`
    /// returns early before adopting — see its doc comment.)
    ModelMismatch,
    /// Recomputing this device's OWN current chunk map for the entry
    /// (`build_indexable_text` + `chunk_indexable_text` on the LIVE
    /// title/content_text) disagrees with `incoming.content_hash` at
    /// `chunk_index` — either the content diverged since the peer computed
    /// this vector, or `chunk_index` no longer exists in the current chunk
    /// map. The device will re-embed locally instead; never stored.
    HashMismatch,
    /// `vec.len() != dim * 4`, or `dim` is `<= 0` or implausibly large —
    /// untrusted-input validation failure. Never stored.
    Malformed,
    /// The entry doesn't exist locally, is soft-deleted, is invisible, or
    /// is locked while the protected-content opt-in is off — mirrors the
    /// write-eligibility gate `ai::indexer::plan_chunk_diff` applies before
    /// a LOCAL embed. Never stored.
    EntryNotEligible,
}

/// Adopt (or reject) one incoming synced chunk vector under the strict
/// adopt-on-match rule (Phase 5 Task 3).
///
/// Checked in order, each a hard gate (any failure stops here, nothing is
/// stored):
///
/// 1. `is_active_model` — the caller has already checked that
///    `incoming.model_id` matches the CONFIGURED embedding slot (see
///    `commands::ai_provider::configured_embedding_model_id` /
///    `SyncEngine::pull_embedding_chunks`), not merely a model_id this
///    device happens to have local rows for. A device never adopts vectors
///    for a model it isn't configured to use.
/// 2. Shape validation on the untrusted vector bytes: `dim` must be
///    plausible and `vec.len()` must equal `dim * 4` exactly.
/// 3. The entry must be locally write-eligible RIGHT NOW: not deleted, not
///    invisible, and not locked unless `include_protected` is on — the
///    exact gate `plan_chunk_diff` applies before a local embed.
/// 4. This device's OWN current chunk map for the entry — recomputed via
///    `build_indexable_text` + `chunk_indexable_text` on the entry's LIVE
///    title/content_text, never trusted peer metadata — must have a chunk
///    at `incoming.chunk_index` whose `content_hash` equals
///    `incoming.content_hash`. This is what guarantees an adopted vector
///    always corresponds to what this device would itself compute for
///    that chunk right now, even if this device has never embedded that
///    chunk before (no local `entry_embedding_chunks` row to compare
///    against otherwise).
///
/// Only when all four hold is [`upsert_chunk`] called — using this
/// device's own recomputed `char_start`/`char_end`/`preview` for that
/// `chunk_index` (the incoming payload carries none of those three; see
/// `sync::embedding_sync::EmbeddingChunkVector`).
pub fn adopt_synced_chunk_vector(
    conn: &Connection,
    is_active_model: bool,
    incoming: &IncomingChunkVector,
    include_protected: bool,
    now: i64,
) -> Result<AdoptOutcome> {
    if !is_active_model {
        return Ok(AdoptOutcome::ModelMismatch);
    }
    if incoming.dim <= 0 || incoming.dim > MAX_PLAUSIBLE_DIM {
        return Ok(AdoptOutcome::Malformed);
    }
    if incoming.vec.len() as i64 != incoming.dim * 4 {
        return Ok(AdoptOutcome::Malformed);
    }

    let entry = match crate::db::queries::get_entry_for_provider(conn, &incoming.entry_id)? {
        Some(e) => e,
        None => return Ok(AdoptOutcome::EntryNotEligible),
    };
    if entry.is_locked && !include_protected {
        return Ok(AdoptOutcome::EntryNotEligible);
    }

    let text = crate::ai::indexer::build_indexable_text(
        entry.title.as_deref(),
        entry.content_text.as_deref(),
    );
    let local_chunk = crate::ai::chunking::chunk_indexable_text(&text)
        .into_iter()
        .find(|c| c.chunk_index as i64 == incoming.chunk_index);

    let Some(chunk) = local_chunk else {
        return Ok(AdoptOutcome::HashMismatch);
    };
    if chunk.content_hash != incoming.content_hash {
        return Ok(AdoptOutcome::HashMismatch);
    }

    let vec = blob_to_vec(&incoming.vec).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, e.into())
    })?;
    upsert_chunk(
        conn,
        &incoming.entry_id,
        &incoming.model_id,
        incoming.chunk_index,
        &incoming.content_hash,
        chunk.char_start as i64,
        chunk.char_end as i64,
        Some(&chunk.preview),
        incoming.dim as usize,
        &vec,
        now,
    )?;
    Ok(AdoptOutcome::Adopted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        schema::migrate(&conn).expect("migrate");
        conn
    }

    fn insert_test_entry(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) \
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date,
                created_at, updated_at)
             VALUES (?1, 'j1', 't', 'c', 0, 0, 0)",
            params![id],
        )
        .expect("insert entry");
    }

    /// Like [`insert_test_entry`], but with a caller-chosen `entry_date` —
    /// needed by the [`retrieve_top_k_in_range`] tests below.
    fn insert_test_entry_with_date(conn: &Connection, id: &str, entry_date: i64) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) \
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date,
                created_at, updated_at)
             VALUES (?1, 'j1', 't', 'c', ?2, 0, 0)",
            params![id, entry_date],
        )
        .expect("insert entry");
    }

    #[test]
    fn vec_to_blob_round_trip() {
        let v = vec![0.0_f32, 1.5, -2.25, 1e-10, 1e10];
        let blob = vec_to_blob(&v);
        assert_eq!(blob.len(), v.len() * 4);
        let back = blob_to_vec(&blob).expect("decode");
        assert_eq!(back, v);
    }

    #[test]
    fn blob_to_vec_rejects_misaligned_length() {
        let bad = vec![0u8, 1, 2]; // 3 bytes, not multiple of 4
        assert!(blob_to_vec(&bad).is_err());
    }

    // NOTE: the legacy entry-level tests that used to live here
    // (upsert_then_get_embedding_returns_row, upsert_replaces_existing_row,
    // list_unindexed_skips_indexed_and_deleted,
    // list_unindexed_skips_invisible_entries,
    // count_embeddings_filters_by_model_id, entry_delete_cascades_embeddings,
    // delete_embeddings_for_entry_*, delete_embeddings_for_model_returns_count)
    // asserted behavior against the `entries_embeddings` table, which Task 1
    // of this phase dropped. They are removed rather than fixed because the
    // functions they exercised are compile-compat shims for out-of-scope
    // callers (see the comment above `EmbeddingRow`) — Task 4/5/6 deletes
    // both the functions and any remaining tests together.

    // `retrieve_top_k` / `list_vectors_for_model` rank over
    // `entry_embedding_chunks`, grouping multiple chunk hits per entry
    // (Task 5). Seed via `upsert_chunk`.
    #[test]
    fn retrieve_top_k_orders_by_cosine_desc() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        // Query points along x-axis; e2 is closest, e3 orthogonal, e1 opposite.
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 2, &[-1.0, 0.0], 0).unwrap();
        upsert_chunk(&conn, "e2", "m", 0, "h2", 0, 1, None, 2, &[1.0, 0.0], 0).unwrap();
        upsert_chunk(&conn, "e3", "m", 0, "h3", 0, 1, None, 2, &[0.0, 1.0], 0).unwrap();

        let query = vec![1.0_f32, 0.0];
        let hits = retrieve_top_k(&conn, &query, "m", 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].entry_id, "e2");
        assert!(hits[0].score > hits[1].score);
        assert_eq!(hits[1].entry_id, "e3");
    }

    #[test]
    fn retrieve_top_k_empty_index_returns_empty() {
        let conn = open_test_db();
        let hits = retrieve_top_k(&conn, &[1.0, 0.0], "m", 5).unwrap();
        assert!(hits.is_empty());
    }

    /// Regression guard: an entry with multiple chunks must occupy exactly
    /// ONE slot in the result — the naive (ungrouped) implementation would
    /// let e1's two chunks fill both top-2 slots, crowding out e2 entirely.
    /// Grouping must keep only e1's best-scoring chunk.
    #[test]
    fn retrieve_top_k_groups_multiple_chunks_by_entry_keeping_best() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");

        // e1 has two chunks: a weak match (chunk 0) and a strong match
        // (chunk 1, exact alignment with the query).
        upsert_chunk(
            &conn,
            "e1",
            "m",
            0,
            "h1a",
            0,
            1,
            Some("weak chunk"),
            2,
            &[0.0, 1.0],
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "e1",
            "m",
            1,
            "h1b",
            1,
            2,
            Some("strong chunk"),
            2,
            &[1.0, 0.0],
            0,
        )
        .unwrap();
        // e2 has one chunk, a middling match.
        upsert_chunk(
            &conn,
            "e2",
            "m",
            0,
            "h2",
            0,
            1,
            Some("e2 chunk"),
            2,
            &[0.6, 0.8],
            0,
        )
        .unwrap();

        let query = vec![1.0_f32, 0.0];
        let hits = retrieve_top_k(&conn, &query, "m", 10).unwrap();

        // Exactly one hit per entry, never one per chunk.
        assert_eq!(hits.len(), 2, "must group to one hit per entry");
        assert_eq!(hits[0].entry_id, "e1", "e1's best chunk wins the top spot");
        assert_eq!(hits[0].chunk_index, 1, "must report the WINNING chunk");
        assert_eq!(hits[0].preview.as_deref(), Some("strong chunk"));
        assert!((hits[0].score - 1.0).abs() < 1e-6);
        assert_eq!(
            hits[0].content_hash, "h1b",
            "must report the WINNING chunk's content_hash, not the losing chunk's"
        );
        assert_eq!(hits[1].entry_id, "e2");
        assert_eq!(hits[1].content_hash, "h2");
    }

    // ── `retrieve_top_k_in_range` ───────────────────────────────────────────

    #[test]
    fn retrieve_top_k_in_range_excludes_entries_outside_range() {
        let conn = open_test_db();
        insert_test_entry_with_date(&conn, "in_range", 100);
        insert_test_entry_with_date(&conn, "before_range", 50);
        insert_test_entry_with_date(&conn, "after_range", 200);

        let query = vec![1.0_f32, 0.0];
        // All three chunks are exact matches for the query — score alone
        // can't explain exclusion, only the date filter can.
        upsert_chunk(&conn, "in_range", "m", 0, "h1", 0, 1, None, 2, &query, 0).unwrap();
        upsert_chunk(
            &conn,
            "before_range",
            "m",
            0,
            "h2",
            0,
            1,
            None,
            2,
            &query,
            0,
        )
        .unwrap();
        upsert_chunk(&conn, "after_range", "m", 0, "h3", 0, 1, None, 2, &query, 0).unwrap();

        let hits = retrieve_top_k_in_range(&conn, &query, "m", 10, 100, 200).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.entry_id.as_str()).collect();
        assert_eq!(ids, vec!["in_range"]);
    }

    /// This is the test that fails if `retrieve_top_k_in_range` is
    /// implemented as a post-filter over `retrieve_top_k`'s global top-k
    /// output: 20 out-of-range entries score higher than the 2 in-range
    /// ones, so a global top-k=8 would be entirely out-of-range chunks and
    /// post-filtering would return nothing.
    #[test]
    fn retrieve_top_k_in_range_returns_in_range_hits_a_global_top_k_would_miss() {
        let conn = open_test_db();
        let query = vec![1.0_f32, 0.0];

        // 20 high-scoring entries OUTSIDE the target range [1000, 2000).
        for i in 0..20 {
            let id = format!("outside_{i}");
            insert_test_entry_with_date(&conn, &id, 0);
            upsert_chunk(
                &conn,
                &id,
                "m",
                0,
                &format!("h_outside_{i}"),
                0,
                1,
                None,
                2,
                &[1.0, 0.0], // perfect cosine match: score 1.0
                0,
            )
            .unwrap();
        }

        // 2 low-scoring entries INSIDE the target range.
        insert_test_entry_with_date(&conn, "inside_1", 1500);
        insert_test_entry_with_date(&conn, "inside_2", 1600);
        upsert_chunk(
            &conn,
            "inside_1",
            "m",
            0,
            "h_inside_1",
            0,
            1,
            None,
            2,
            &[0.1, 0.9], // weak cosine match
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "inside_2",
            "m",
            0,
            "h_inside_2",
            0,
            1,
            None,
            2,
            &[0.2, 0.8], // weak cosine match
            0,
        )
        .unwrap();

        // Sanity check the fixture's premise: a global top-8 is dominated
        // entirely by the outside entries, containing neither inside entry.
        let global = retrieve_top_k(&conn, &query, "m", 8).unwrap();
        assert_eq!(global.len(), 8);
        assert!(
            global.iter().all(|h| h.entry_id.starts_with("outside_")),
            "fixture must make the outside entries dominate a global top-8"
        );

        let scoped = retrieve_top_k_in_range(&conn, &query, "m", 8, 1000, 2000).unwrap();
        let mut ids: Vec<&str> = scoped.iter().map(|h| h.entry_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["inside_1", "inside_2"]);
    }

    #[test]
    fn retrieve_top_k_in_range_empty_range_returns_empty_not_error() {
        let conn = open_test_db();
        insert_test_entry_with_date(&conn, "e1", 100);
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 2, &[1.0, 0.0], 0).unwrap();

        // from_ts == to_ts: an empty half-open range must never match.
        let hits = retrieve_top_k_in_range(&conn, &[1.0, 0.0], "m", 10, 100, 100).unwrap();
        assert!(hits.is_empty());

        // Well-formed but empty of entries: a period with no matching rows
        // must also come back Ok(empty), not an error.
        let hits = retrieve_top_k_in_range(&conn, &[1.0, 0.0], "m", 10, 500, 600).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn retrieve_top_k_in_range_from_ts_inclusive_to_ts_exclusive() {
        let conn = open_test_db();
        insert_test_entry_with_date(&conn, "at_from", 100);
        insert_test_entry_with_date(&conn, "at_to", 200);
        let query = vec![1.0_f32, 0.0];
        upsert_chunk(&conn, "at_from", "m", 0, "h1", 0, 1, None, 2, &query, 0).unwrap();
        upsert_chunk(&conn, "at_to", "m", 0, "h2", 0, 1, None, 2, &query, 0).unwrap();

        let hits = retrieve_top_k_in_range(&conn, &query, "m", 10, 100, 200).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.entry_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["at_from"],
            "from_ts must be inclusive and to_ts exclusive"
        );
    }

    #[test]
    fn list_vectors_for_model_returns_only_active_model_and_skips_deleted() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 2, &[0.1, 0.2], 0).unwrap();
        upsert_chunk(&conn, "e2", "m", 0, "h2", 0, 1, None, 2, &[0.3, 0.4], 0).unwrap();
        upsert_chunk(&conn, "e3", "m", 0, "h3", 0, 1, None, 2, &[0.5, 0.6], 0).unwrap();
        // Different model — must NOT appear.
        upsert_chunk(
            &conn,
            "e1",
            "other",
            0,
            "h1o",
            0,
            1,
            None,
            2,
            &[0.9, 0.9],
            0,
        )
        .unwrap();
        // Soft-delete e2 — must NOT appear.
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e2'", [])
            .unwrap();

        let mut got = list_vectors_for_model(&conn, "m").unwrap();
        got.sort_by(|a, b| a.entry_id.cmp(&b.entry_id));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].entry_id, "e1");
        assert_eq!(got[0].vec, vec![0.1, 0.2]);
        assert_eq!(got[1].entry_id, "e3");
    }

    #[test]
    fn mean_pool_vectors_returns_element_wise_mean() {
        let vectors = vec![vec![1.0_f32, 0.0, 2.0], vec![3.0, 4.0, 0.0]];
        let pooled = mean_pool_vectors(&vectors).unwrap();
        assert_eq!(pooled, vec![2.0, 2.0, 1.0]);
    }

    #[test]
    fn mean_pool_vectors_single_vector_returns_itself() {
        let vectors = vec![vec![0.6_f32, 0.8]];
        let pooled = mean_pool_vectors(&vectors).unwrap();
        assert_eq!(pooled, vec![0.6, 0.8]);
    }

    #[test]
    fn mean_pool_vectors_empty_returns_none() {
        assert_eq!(mean_pool_vectors(&[]), None);
    }

    /// FIX 4 regression guard: `dim` is fixed by the FIRST vector; any
    /// later vector whose length disagrees must be silently skipped
    /// (`if v.len() != dim { continue; }`) rather than corrupting the sum
    /// or panicking. The pooled result must equal the element-wise mean
    /// of only the matching-dim vectors.
    #[test]
    fn mean_pool_vectors_skips_mismatched_dim_vector() {
        let vectors = vec![
            vec![1.0_f32, 0.0, 2.0], // dim 3 — sets `dim`.
            vec![9.0_f32, 9.0],      // dim 2 — mismatched, must be skipped.
            vec![3.0_f32, 4.0, 0.0], // dim 3 — matches.
        ];
        let pooled = mean_pool_vectors(&vectors).unwrap();
        // Mean of only the two dim-3 vectors: [(1+3)/2, (0+4)/2, (2+0)/2].
        assert_eq!(pooled, vec![2.0, 2.0, 1.0]);
    }

    #[test]
    fn count_indexed_entries_for_model_counts_distinct_entries_excludes_deleted() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e_deleted");
        // e1 has two chunks — must still count as ONE indexed entry.
        upsert_chunk(&conn, "e1", "m", 0, "h1a", 0, 1, None, 1, &[0.1], 0).unwrap();
        upsert_chunk(&conn, "e1", "m", 1, "h1b", 1, 2, None, 1, &[0.2], 0).unwrap();
        upsert_chunk(&conn, "e2", "m", 0, "h2", 0, 1, None, 1, &[0.3], 0).unwrap();
        upsert_chunk(&conn, "e_deleted", "m", 0, "hd", 0, 1, None, 1, &[0.4], 0).unwrap();
        conn.execute(
            "UPDATE entries SET is_deleted = 1 WHERE id = 'e_deleted'",
            [],
        )
        .unwrap();

        let n = count_indexed_entries_for_model(&conn, "m", false).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn delete_chunks_for_model_removes_only_that_model() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 1, &[0.1], 0).unwrap();
        upsert_chunk(&conn, "e1", "other", 0, "h2", 0, 1, None, 1, &[0.2], 0).unwrap();

        let n = delete_chunks_for_model(&conn, "m").unwrap();
        assert_eq!(n, 1);
        assert!(list_stored_chunks(&conn, "e1", "m").unwrap().is_empty());
        assert_eq!(list_stored_chunks(&conn, "e1", "other").unwrap().len(), 1);
    }

    // ── Chunk store ──────────────────────────────────────────────────────

    /// Entries are only SOFT-deleted, so the `ON DELETE CASCADE` on both
    /// embedding tables never fires. Without an explicit sweep a deleted
    /// entry's vectors live in the encrypted DB forever.
    #[test]
    fn delete_index_for_deleted_entries_by_entry_id() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        for id in ["e1", "e2"] {
            upsert_chunk(&conn, id, "m", 0, "h", 0, 4, None, 1, &[0.1], 0).unwrap();
            mark_entry_embedding_dirty(&conn, id, "m", "h", 0, 0).unwrap();
        }

        delete_index_for_deleted_entries(&conn, None, Some("e1")).unwrap();

        assert_eq!(count_rows(&conn, "entry_embedding_chunks", "e1"), 0);
        assert_eq!(count_rows(&conn, "entry_embedding_jobs", "e1"), 0);
        assert_eq!(
            count_rows(&conn, "entry_embedding_chunks", "e2"),
            1,
            "must not touch another entry"
        );
        assert_eq!(count_rows(&conn, "entry_embedding_jobs", "e2"), 1);
    }

    /// Journal scope: one pair of statements regardless of how many entries
    /// the journal holds (the I9 no-per-entry-loops rule).
    #[test]
    fn delete_index_for_deleted_entries_by_journal_id() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        // A third entry in a DIFFERENT journal must survive.
        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at) VALUES ('j2', 'J2', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date, \
                created_at, updated_at) \
             VALUES ('e3', 'j2', 't', 'c', 0, 0, 0)",
            [],
        )
        .unwrap();
        for id in ["e1", "e2", "e3"] {
            upsert_chunk(&conn, id, "m", 0, "h", 0, 4, None, 1, &[0.1], 0).unwrap();
            mark_entry_embedding_dirty(&conn, id, "m", "h", 0, 0).unwrap();
        }

        delete_index_for_deleted_entries(&conn, Some("j1"), None).unwrap();

        for id in ["e1", "e2"] {
            assert_eq!(count_rows(&conn, "entry_embedding_chunks", id), 0);
            assert_eq!(count_rows(&conn, "entry_embedding_jobs", id), 0);
        }
        assert_eq!(
            count_rows(&conn, "entry_embedding_chunks", "e3"),
            1,
            "another journal's index must survive"
        );
        assert_eq!(count_rows(&conn, "entry_embedding_jobs", "e3"), 1);
    }

    /// Both `None` is a no-op, never a table-wide wipe.
    #[test]
    fn delete_index_for_deleted_entries_without_scope_is_a_noop() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h", 0, 4, None, 1, &[0.1], 0).unwrap();

        delete_index_for_deleted_entries(&conn, None, None).unwrap();

        assert_eq!(count_rows(&conn, "entry_embedding_chunks", "e1"), 1);
    }

    fn count_rows(conn: &Connection, table: &str, entry_id: &str) -> i64 {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE entry_id = ?1"),
            params![entry_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn upsert_chunk_and_list_stored_chunks_round_trip() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(
            &conn,
            "e1",
            "m",
            0,
            "hash-a",
            0,
            10,
            Some("preview a"),
            3,
            &[0.1, 0.2, 0.3],
            100,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "e1",
            "m",
            1,
            "hash-b",
            10,
            20,
            None,
            2,
            &[0.4, 0.5],
            100,
        )
        .unwrap();

        let chunks = list_stored_chunks(&conn, "e1", "m").unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chunk_index, 0);
        assert_eq!(chunks[0].content_hash, "hash-a");
        assert_eq!(chunks[0].preview.as_deref(), Some("preview a"));
        assert_eq!(chunks[0].vec, vec![0.1, 0.2, 0.3]);
        assert_eq!(chunks[1].chunk_index, 1);
        assert_eq!(chunks[1].preview, None);

        // Upsert on an existing (entry_id, model_id, chunk_index) replaces
        // in place, never duplicates.
        upsert_chunk(
            &conn,
            "e1",
            "m",
            0,
            "hash-a2",
            0,
            12,
            Some("updated"),
            3,
            &[0.9, 0.9, 0.9],
            200,
        )
        .unwrap();
        let chunks2 = list_stored_chunks(&conn, "e1", "m").unwrap();
        assert_eq!(chunks2.len(), 2, "upsert must replace, not duplicate");
        assert_eq!(chunks2[0].content_hash, "hash-a2");
        assert_eq!(chunks2[0].vec, vec![0.9, 0.9, 0.9]);
    }

    #[test]
    fn delete_chunks_not_in_drops_removed_keeps_rest() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        for i in 0..4i64 {
            upsert_chunk(
                &conn,
                "e1",
                "m",
                i,
                &format!("h{i}"),
                0,
                1,
                None,
                1,
                &[0.1],
                0,
            )
            .unwrap();
        }
        let n = delete_chunks_not_in(&conn, "e1", "m", &[0, 2]).unwrap();
        assert_eq!(n, 2);
        let remaining = list_stored_chunks(&conn, "e1", "m").unwrap();
        let idxs: Vec<i64> = remaining.iter().map(|c| c.chunk_index).collect();
        assert_eq!(idxs, vec![0, 2]);
    }

    #[test]
    fn delete_chunks_not_in_with_empty_keep_deletes_all() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h", 0, 1, None, 1, &[0.1], 0).unwrap();
        let n = delete_chunks_not_in(&conn, "e1", "m", &[]).unwrap();
        assert_eq!(n, 1);
        assert!(list_stored_chunks(&conn, "e1", "m").unwrap().is_empty());
    }

    // Regression guard for the capture-later note on Task 2: re-chunking
    // after a one-paragraph edit shifts every later chunk_index, but the
    // DB layer must let callers identify the genuinely changed chunk by
    // content_hash across the whole set — not by hash-at-the-same-index.
    #[test]
    fn content_hash_matching_survives_chunk_index_shift() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        // Original: two chunks, "intro" then "body".
        upsert_chunk(
            &conn,
            "e1",
            "m",
            0,
            "hash-intro",
            0,
            10,
            Some("intro"),
            2,
            &[0.1, 0.1],
            100,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "e1",
            "m",
            1,
            "hash-body",
            10,
            20,
            Some("body"),
            2,
            &[0.2, 0.2],
            100,
        )
        .unwrap();

        let stored_before = list_stored_chunks(&conn, "e1", "m").unwrap();
        let before_hashes: std::collections::HashSet<&str> = stored_before
            .iter()
            .map(|c| c.content_hash.as_str())
            .collect();

        // Simulate a re-chunk after a paragraph was inserted at the top:
        // "intro"/"body" content is unchanged (same hash) but both shift
        // down one chunk_index, and a brand-new "preface" chunk lands at 0.
        let new_chunks = [
            (0i64, "hash-preface"),
            (1i64, "hash-intro"),
            (2i64, "hash-body"),
        ];

        // The caller must be able to identify exactly which new chunk is
        // genuinely new content by comparing hashes across the whole
        // stored set — not by chunk_index.
        let changed: Vec<&str> = new_chunks
            .iter()
            .filter(|(_, hash)| !before_hashes.contains(hash))
            .map(|(_, hash)| *hash)
            .collect();
        assert_eq!(
            changed,
            vec!["hash-preface"],
            "only the genuinely new chunk should be flagged for re-embedding, \
             not hash-intro/hash-body just because their chunk_index moved"
        );

        // Worker writes all three (reusing the stored vec for unchanged
        // hashes — no embed provider call — and only computing a fresh
        // vector for "hash-preface"), then prunes anything no longer
        // present via delete_chunks_not_in.
        upsert_chunk(
            &conn,
            "e1",
            "m",
            0,
            "hash-preface",
            0,
            5,
            Some("preface"),
            2,
            &[0.3, 0.3],
            200,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "e1",
            "m",
            1,
            "hash-intro",
            5,
            15,
            Some("intro"),
            2,
            &[0.1, 0.1],
            200,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "e1",
            "m",
            2,
            "hash-body",
            15,
            25,
            Some("body"),
            2,
            &[0.2, 0.2],
            200,
        )
        .unwrap();
        delete_chunks_not_in(&conn, "e1", "m", &[0, 1, 2]).unwrap();

        let stored_after = list_stored_chunks(&conn, "e1", "m").unwrap();
        let after_pairs: Vec<(i64, &str)> = stored_after
            .iter()
            .map(|c| (c.chunk_index, c.content_hash.as_str()))
            .collect();
        assert_eq!(
            after_pairs,
            vec![(0, "hash-preface"), (1, "hash-intro"), (2, "hash-body")]
        );
        // The unchanged chunk's vec is exactly what the worker would have
        // reused (no re-embed) rather than a freshly computed vector.
        assert_eq!(stored_after[1].vec, vec![0.1, 0.1]);
    }

    // ── Dirty queue ──────────────────────────────────────────────────────

    #[test]
    fn mark_entry_embedding_dirty_upserts_single_row_on_repeat_calls() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        mark_entry_embedding_dirty(&conn, "e1", "m", "hash-1", 100, 50).unwrap();
        mark_entry_embedding_dirty(&conn, "e1", "m", "hash-2", 200, 60).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id='m'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "repeated dirty marks must keep exactly one job row");

        let jobs = claim_due_embedding_jobs(&conn, "m", 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].content_hash, "hash-2", "latest mark must win");
        assert_eq!(jobs[0].status, "in_progress");
    }

    #[test]
    fn claim_due_embedding_jobs_returns_due_recency_first_and_respects_limit() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e_old");
        insert_test_entry(&conn, "e_new");
        insert_test_entry(&conn, "e_not_due");
        insert_test_entry(&conn, "e_indexed");
        conn.execute("UPDATE entries SET updated_at = 100 WHERE id = 'e_old'", [])
            .unwrap();
        conn.execute("UPDATE entries SET updated_at = 200 WHERE id = 'e_new'", [])
            .unwrap();

        mark_entry_embedding_dirty(&conn, "e_old", "m", "h1", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e_new", "m", "h2", 0, 0).unwrap();
        // Not due yet — next_attempt_at is in the future relative to `now`.
        mark_entry_embedding_dirty(&conn, "e_not_due", "m", "h3", 10_000, 0).unwrap();
        // Already indexed — must never be re-claimed.
        mark_entry_embedding_dirty(&conn, "e_indexed", "m", "h4", 0, 0).unwrap();
        complete_embedding_job(&conn, "e_indexed", "m", 0).unwrap();

        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 500, false).unwrap();
        let ids: Vec<&str> = claimed.iter().map(|j| j.entry_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["e_new", "e_old"],
            "must be recency-first (newest entry first)"
        );

        // limit respected
        let conn2 = open_test_db();
        insert_test_entry(&conn2, "a");
        insert_test_entry(&conn2, "b");
        insert_test_entry(&conn2, "c");
        conn2
            .execute("UPDATE entries SET updated_at = 1 WHERE id='a'", [])
            .unwrap();
        conn2
            .execute("UPDATE entries SET updated_at = 2 WHERE id='b'", [])
            .unwrap();
        conn2
            .execute("UPDATE entries SET updated_at = 3 WHERE id='c'", [])
            .unwrap();
        mark_entry_embedding_dirty(&conn2, "a", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn2, "b", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn2, "c", "m", "h", 0, 0).unwrap();
        let claimed2 = claim_due_embedding_jobs(&conn2, "m", 2, 500, false).unwrap();
        assert_eq!(claimed2.len(), 2);
        assert_eq!(claimed2[0].entry_id, "c");
        assert_eq!(claimed2[1].entry_id, "b");
    }

    #[test]
    fn claim_due_embedding_jobs_includes_error_status_but_not_paused() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e_error");
        insert_test_entry(&conn, "e_paused");
        mark_entry_embedding_dirty(&conn, "e_error", "m", "h", 0, 0).unwrap();
        fail_embedding_job(&conn, "e_error", "m", "boom", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e_paused", "m", "h", 0, 0).unwrap();
        conn.execute(
            "UPDATE entry_embedding_jobs SET status = 'paused' WHERE entry_id = 'e_paused'",
            [],
        )
        .unwrap();

        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 500, false).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].entry_id, "e_error");
        assert_eq!(claimed[0].status, "in_progress");
        assert_eq!(claimed[0].attempt_count, 1);
    }

    #[test]
    fn claim_due_embedding_jobs_excludes_soft_deleted_entries() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e2", "m", "h", 0, 0).unwrap();
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e1'", [])
            .unwrap();

        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 500, false).unwrap();
        let ids: Vec<&str> = claimed.iter().map(|j| j.entry_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["e2"],
            "a job left behind by a soft-deleted entry must never be claimed \
             (would burn a provider call on content read-side filtering \
             already drops)"
        );
    }

    /// C2 claim-time layer: a locked entry's job is excluded by default
    /// (`include_protected = false`) and an invisible entry's job is
    /// ALWAYS excluded, regardless of `include_protected` — mirrors the
    /// exact asymmetry `list_entries_needing_index` applies on the write
    /// side.
    #[test]
    fn claim_due_embedding_jobs_excludes_locked_by_default_and_invisible_always() {
        // Default (include_protected = false): only "visible" is claimable.
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "locked");
        insert_test_entry(&conn, "invisible");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
            [],
        )
        .unwrap();
        mark_entry_embedding_dirty(&conn, "visible", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "locked", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "invisible", "m", "h", 0, 0).unwrap();

        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 500, false).unwrap();
        let ids: Vec<&str> = claimed.iter().map(|j| j.entry_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["visible"],
            "locked and invisible entries must not be claimed by default"
        );

        // Fresh DB — include_protected = true: locked becomes claimable,
        // invisible STILL never is.
        let conn2 = open_test_db();
        insert_test_entry(&conn2, "visible");
        insert_test_entry(&conn2, "locked");
        insert_test_entry(&conn2, "invisible");
        conn2
            .execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn2
            .execute(
                "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
                [],
            )
            .unwrap();
        mark_entry_embedding_dirty(&conn2, "visible", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn2, "locked", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn2, "invisible", "m", "h", 0, 0).unwrap();

        let claimed2 = claim_due_embedding_jobs(&conn2, "m", 10, 500, true).unwrap();
        let mut ids2: Vec<&str> = claimed2.iter().map(|j| j.entry_id.as_str()).collect();
        ids2.sort();
        assert_eq!(
            ids2,
            vec!["locked", "visible"],
            "include_protected=true surfaces locked entries but invisible \
             entries must NEVER be claimable"
        );
    }

    #[test]
    fn mark_entry_embedding_dirty_resets_attempt_count_and_last_error() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h1", 0, 0).unwrap();
        fail_embedding_job(&conn, "e1", "m", "boom", 0, 0).unwrap();

        // A fresh edit re-dirties the job — it deserves a clean attempt
        // budget rather than inheriting backoff state from content that no
        // longer exists.
        mark_entry_embedding_dirty(&conn, "e1", "m", "h2", 0, 10).unwrap();
        let (attempt_count, last_error): (i64, Option<String>) = conn
            .query_row(
                "SELECT attempt_count, last_error FROM entry_embedding_jobs \
                 WHERE entry_id='e1' AND model_id='m'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(attempt_count, 0);
        assert_eq!(last_error, None);
    }

    #[test]
    fn job_status_transitions_complete_skip_fail_reset() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h", 0, 0).unwrap();

        let status = |conn: &Connection| -> String {
            conn.query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id='m'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        complete_embedding_job(&conn, "e1", "m", 10).unwrap();
        assert_eq!(status(&conn), "indexed");

        skip_embedding_job(&conn, "e1", "m", 20).unwrap();
        assert_eq!(status(&conn), "skipped");

        fail_embedding_job(&conn, "e1", "m", "boom", 999, 30).unwrap();
        let (st, attempt_count, last_error, next_attempt_at): (
            String,
            i64,
            Option<String>,
            Option<i64>,
        ) = conn
            .query_row(
                "SELECT status, attempt_count, last_error, next_attempt_at \
                 FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id='m'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(st, "error");
        assert_eq!(attempt_count, 1);
        assert_eq!(last_error.as_deref(), Some("boom"));
        assert_eq!(next_attempt_at, Some(999));

        reset_embedding_job_to_pending(&conn, "e1", "m", "fresh-hash", 0, 40).unwrap();
        assert_eq!(status(&conn), "pending");
        let hash: String = conn
            .query_row(
                "SELECT content_hash FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id='m'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hash, "fresh-hash", "reset stamps the latest content_hash");
    }

    #[test]
    fn recover_stranded_in_progress_jobs_resets_only_in_progress_rows() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e2", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e3", "m", "h", 0, 0).unwrap();
        // e1 gets stranded in_progress (simulates a cancelled/crashed tick);
        // e2 stays pending; e3 already completed.
        conn.execute(
            "UPDATE entry_embedding_jobs SET status = 'in_progress' WHERE entry_id = 'e1'",
            [],
        )
        .unwrap();
        complete_embedding_job(&conn, "e3", "m", 0).unwrap();

        let recovered = recover_stranded_in_progress_jobs(&conn, 500).unwrap();
        assert_eq!(recovered, 1, "only the stranded row is recovered");

        let status = |id: &str| -> String {
            conn.query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id=?1 AND model_id='m'",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(status("e1"), "pending", "stranded job recovers to pending");
        assert_eq!(status("e2"), "pending", "untouched pending row unaffected");
        assert_eq!(status("e3"), "indexed", "already-completed row unaffected");

        let next_attempt_at: i64 = conn
            .query_row(
                "SELECT next_attempt_at FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id='m'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            next_attempt_at, 500,
            "recovered job is immediately claimable"
        );
    }

    /// C3 fix: `reset_all_jobs_for_model_to_pending` resets EVERY status
    /// (not just `in_progress`) for `model_id` — the force-reindex
    /// counterpart to `recover_stranded_in_progress_jobs`. A job stuck at
    /// `indexed` after a chunk wipe would otherwise never be re-selected
    /// by `claim_due_embedding_jobs`'s `pending`/`error` filter.
    #[test]
    fn reset_all_jobs_for_model_to_pending_resets_every_status_for_that_model_only() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e_indexed");
        insert_test_entry(&conn, "e_error");
        insert_test_entry(&conn, "e_paused");
        insert_test_entry(&conn, "e_other_model");
        mark_entry_embedding_dirty(&conn, "e_indexed", "m", "h", 0, 0).unwrap();
        complete_embedding_job(&conn, "e_indexed", "m", 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e_error", "m", "h", 0, 0).unwrap();
        fail_embedding_job(&conn, "e_error", "m", "boom", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e_paused", "m", "h", 0, 0).unwrap();
        pause_embedding_job(&conn, "e_paused", "m", "boom", 0).unwrap();
        // Same-entry job under a DIFFERENT model_id must be untouched.
        mark_entry_embedding_dirty(&conn, "e_other_model", "other", "h", 0, 0).unwrap();
        complete_embedding_job(&conn, "e_other_model", "other", 0).unwrap();

        let n = reset_all_jobs_for_model_to_pending(&conn, "m", 999, 1000).unwrap();
        assert_eq!(n, 3, "only the three 'm' rows are reset");

        let status = |id: &str, model: &str| -> String {
            conn.query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id=?1 AND model_id=?2",
                params![id, model],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(status("e_indexed", "m"), "pending");
        assert_eq!(status("e_error", "m"), "pending");
        assert_eq!(status("e_paused", "m"), "pending");
        assert_eq!(
            status("e_other_model", "other"),
            "indexed",
            "a different model_id's job row must be untouched"
        );

        let next_attempt_at: i64 = conn
            .query_row(
                "SELECT next_attempt_at FROM entry_embedding_jobs WHERE entry_id='e_indexed' AND model_id='m'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(next_attempt_at, 999, "reset jobs are immediately claimable");

        // Now claimable through the real claim path.
        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 999, false).unwrap();
        let mut ids: Vec<&str> = claimed.iter().map(|j| j.entry_id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["e_error", "e_indexed", "e_paused"]);
    }

    // ── reset_unfinished_jobs_to_pending ("Index now" unstick, 2026-08-04) ──

    #[test]
    fn reset_unfinished_jobs_to_pending_unsticks_every_dead_end_state() {
        let conn = open_test_db();
        // The four ways a job row becomes permanently (or indefinitely)
        // unclaimable while its entry still counts as `pending` in the UI:
        insert_test_entry(&conn, "e_paused");
        insert_test_entry(&conn, "e_skipped_stale");
        insert_test_entry(&conn, "e_ms_scale");
        insert_test_entry(&conn, "e_backoff");
        // 1. `paused` — auth/config-class failure, never retried on its own.
        mark_entry_embedding_dirty(&conn, "e_paused", "m", "h", 0, 0).unwrap();
        pause_embedding_job(&conn, "e_paused", "m", "AI_MODEL_NOT_READY", 0).unwrap();
        // 2. Stale `skipped` — entry edited after the skip WITHOUT the save
        //    hook re-dirtying it (e.g. a sync-applied edit).
        mark_entry_embedding_dirty(&conn, "e_skipped_stale", "m", "h", 0, 0).unwrap();
        skip_embedding_job(&conn, "e_skipped_stale", "m", 0).unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = 500 WHERE id = 'e_skipped_stale'",
            [],
        )
        .unwrap();
        // 3. `pending` with a millisecond-scale `next_attempt_at` (pre-C1
        //    corruption) — due ~52,000 years from now.
        mark_entry_embedding_dirty(&conn, "e_ms_scale", "m", "h", 2_000_000_000_000, 0).unwrap();
        // 4. `error` still waiting out its backoff window.
        mark_entry_embedding_dirty(&conn, "e_backoff", "m", "h", 0, 0).unwrap();
        fail_embedding_job(&conn, "e_backoff", "m", "boom", 999_999, 0).unwrap();

        assert!(
            claim_due_embedding_jobs(&conn, "m", 10, 1000, false)
                .unwrap()
                .is_empty(),
            "all four rows must be unclaimable before the reset"
        );

        let n = reset_unfinished_jobs_to_pending(&conn, "m", 1000, 1000).unwrap();
        assert_eq!(n, 4, "every dead-end row must be reset");

        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 1000, false).unwrap();
        assert_eq!(claimed.len(), 4, "every reset row must be claimable now");
        for job in &claimed {
            assert_eq!(job.attempt_count, 0, "explicit re-queue is a fresh start");
            assert_eq!(job.last_error, None);
        }
    }

    #[test]
    fn reset_unfinished_jobs_to_pending_leaves_indexed_in_progress_and_other_models_alone() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e_indexed");
        insert_test_entry(&conn, "e_inflight");
        insert_test_entry(&conn, "e_other_model");
        // `indexed` — resetting it would re-embed everything (that's
        // force/Rebuild's job, not Index now's).
        mark_entry_embedding_dirty(&conn, "e_indexed", "m", "h", 0, 0).unwrap();
        complete_embedding_job(&conn, "e_indexed", "m", 0).unwrap();
        // `in_progress` — an actively-embedding row must not be clobbered.
        mark_entry_embedding_dirty(&conn, "e_inflight", "m", "h", 0, 0).unwrap();
        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 1000, false).unwrap();
        assert_eq!(claimed.len(), 1, "setup: e_inflight is now in_progress");
        // Another model's paused row — job rows are per (entry_id, model_id).
        mark_entry_embedding_dirty(&conn, "e_other_model", "other", "h", 0, 0).unwrap();
        pause_embedding_job(&conn, "e_other_model", "other", "boom", 0).unwrap();

        let n = reset_unfinished_jobs_to_pending(&conn, "m", 1000, 1000).unwrap();
        assert_eq!(n, 0, "indexed/in_progress/other-model rows are untouched");

        assert_eq!(
            get_embedding_job(&conn, "e_indexed", "m")
                .unwrap()
                .unwrap()
                .status,
            "indexed"
        );
        assert_eq!(
            get_embedding_job(&conn, "e_inflight", "m")
                .unwrap()
                .unwrap()
                .status,
            "in_progress"
        );
        assert_eq!(
            get_embedding_job(&conn, "e_other_model", "other")
                .unwrap()
                .unwrap()
                .status,
            "paused"
        );
    }

    // ── reset_paused_jobs_to_pending (C7 fix) ───────────────────────────────

    #[test]
    fn reset_paused_jobs_to_pending_makes_job_claimable_again() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h", 0, 0).unwrap();
        pause_embedding_job(&conn, "e1", "m", "bad api key", 0).unwrap();
        assert!(
            claim_due_embedding_jobs(&conn, "m", 10, 1000, false)
                .unwrap()
                .is_empty(),
            "paused jobs must not be claimable before the reset"
        );

        let n = reset_paused_jobs_to_pending(&conn, "m", 1000, 1000).unwrap();
        assert_eq!(n, 1);

        let claimed = claim_due_embedding_jobs(&conn, "m", 10, 1000, false).unwrap();
        assert_eq!(claimed.len(), 1, "reset job must be claimable again");
        assert_eq!(claimed[0].entry_id, "e1");
        assert_eq!(claimed[0].attempt_count, 0, "recovery is a fresh start");
        assert_eq!(claimed[0].last_error, None);
    }

    #[test]
    fn reset_paused_jobs_to_pending_is_scoped_to_model_and_leaves_other_statuses_alone() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e_paused_a");
        insert_test_entry(&conn, "e_paused_b");
        insert_test_entry(&conn, "e_error_a");
        mark_entry_embedding_dirty(&conn, "e_paused_a", "model-a", "h", 0, 0).unwrap();
        pause_embedding_job(&conn, "e_paused_a", "model-a", "boom", 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e_paused_b", "model-b", "h", 0, 0).unwrap();
        pause_embedding_job(&conn, "e_paused_b", "model-b", "boom", 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e_error_a", "model-a", "h", 0, 0).unwrap();
        fail_embedding_job(&conn, "e_error_a", "model-a", "boom", 0, 0).unwrap();

        let n = reset_paused_jobs_to_pending(&conn, "model-a", 0, 0).unwrap();
        assert_eq!(n, 1, "only model-a's paused row is reset");

        assert_eq!(
            get_embedding_job(&conn, "e_paused_a", "model-a")
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
        assert_eq!(
            get_embedding_job(&conn, "e_paused_b", "model-b")
                .unwrap()
                .unwrap()
                .status,
            "paused",
            "a different model_id's paused row must be untouched"
        );
        assert_eq!(
            get_embedding_job(&conn, "e_error_a", "model-a")
                .unwrap()
                .unwrap()
                .status,
            "error",
            "non-paused rows for the same model must be untouched"
        );
    }

    // ── list_entries_needing_index staleness (C11 fix) ──────────────────────

    #[test]
    fn list_entries_needing_index_excludes_entry_whose_chunks_are_current() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        // entries.updated_at defaults to 0; chunk written later at t=100.
        upsert_chunk(&conn, "e1", "m", 0, "h", 0, 1, None, 1, &[0.1], 100).unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert!(
            needing.is_empty(),
            "chunk rows newer than the entry's updated_at means already current"
        );
    }

    #[test]
    fn list_entries_needing_index_includes_entry_edited_after_its_chunks_were_written() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h", 0, 1, None, 1, &[0.1], 100).unwrap();
        conn.execute("UPDATE entries SET updated_at = 200 WHERE id = 'e1'", [])
            .unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert_eq!(
            needing,
            vec!["e1".to_string()],
            "an entry edited after its chunks were written must be re-surfaced as needing index"
        );
    }

    #[test]
    fn list_embedding_index_stats_counts_by_status() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e2", "m", "h", 0, 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e3", "m", "h", 0, 0).unwrap();
        complete_embedding_job(&conn, "e2", "m", 0).unwrap();
        fail_embedding_job(&conn, "e3", "m", "boom", 0, 0).unwrap();

        let stats = list_embedding_index_stats(&conn, "m").unwrap();
        assert_eq!(stats.pending, 1);
        assert_eq!(stats.indexed, 1);
        assert_eq!(stats.error, 1);
        assert_eq!(stats.in_progress, 0);
        assert_eq!(stats.skipped, 0);
        assert_eq!(stats.paused, 0);
    }

    #[test]
    fn list_entries_needing_index_excludes_entries_with_chunks_and_deleted() {
        let conn = open_test_db();
        insert_test_entry(&conn, "no_chunks");
        insert_test_entry(&conn, "has_chunks");
        insert_test_entry(&conn, "deleted");
        upsert_chunk(&conn, "has_chunks", "m", 0, "h", 0, 1, None, 1, &[0.1], 0).unwrap();
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'deleted'", [])
            .unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert_eq!(needing, vec!["no_chunks".to_string()]);
    }

    // ── count_total_entries_for_model (double-count fix) ──────────────────

    /// A stale-but-chunked entry (chunks exist but `entries.updated_at` is
    /// newer than `MAX(indexed_at)`) is the exact case `indexed + pending`
    /// double-counted: it appears in `count_indexed_entries_for_model` AND
    /// in `list_entries_needing_index`. `count_total_entries_for_model` must
    /// count it exactly once.
    #[test]
    fn count_total_entries_for_model_counts_stale_chunked_entry_once() {
        let conn = open_test_db();
        insert_test_entry(&conn, "fresh");
        insert_test_entry(&conn, "stale_chunked");
        insert_test_entry(&conn, "no_chunks");

        // fresh: chunks newer than updated_at → indexed, not pending
        upsert_chunk(&conn, "fresh", "m", 0, "h", 0, 1, None, 1, &[0.1], 100).unwrap();
        // stale_chunked: chunks older than updated_at → counts as BOTH
        // indexed (it has chunks) AND pending (staleness) under the old
        // formula.
        upsert_chunk(
            &conn,
            "stale_chunked",
            "m",
            0,
            "h",
            0,
            1,
            None,
            1,
            &[0.2],
            100,
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = 200 WHERE id = 'stale_chunked'",
            [],
        )
        .unwrap();
        // no_chunks: no chunks, never indexed → pending only.

        let total = count_total_entries_for_model(&conn, "m", false).unwrap();
        assert_eq!(
            total, 3,
            "all 3 entries are eligible; the stale-but-chunked one must NOT be counted twice"
        );

        // Sanity: the OLD formula would have produced 4 here (indexed=2 +
        // pending=2). The new formula gives 3 because it dedupes by entry.
        let indexed = count_indexed_entries_for_model(&conn, "m", false).unwrap();
        let pending = list_entries_needing_index(&conn, "m", i64::MAX as usize, false)
            .unwrap()
            .len() as u64;
        assert_eq!(indexed, 2);
        assert_eq!(pending, 2);
        assert_eq!(
            total, 3,
            "total must be derived independently of indexed+pending"
        );
    }

    /// `count_total_entries_for_model` must exclude deleted entries and
    /// entries whose latest `entry_embedding_jobs` row is `skipped` —
    /// these never appear in `list_entries_needing_index` either, so the
    /// total denominator must stay consistent with the pending numerator.
    #[test]
    fn count_total_entries_for_model_excludes_deleted_and_skipped() {
        let conn = open_test_db();
        insert_test_entry(&conn, "ok");
        insert_test_entry(&conn, "deleted");
        insert_test_entry(&conn, "skipped");
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'deleted'", [])
            .unwrap();
        // Skipping requires the job row to exist first; `now=100` is past
        // the entry's default `updated_at=0`, so the `ej.updated_at >=
        // e.updated_at` guard in the exclusion predicate holds.
        mark_entry_embedding_dirty(&conn, "skipped", "m", "h", 0, 0).unwrap();
        skip_embedding_job(&conn, "skipped", "m", 100).unwrap();

        let total = count_total_entries_for_model(&conn, "m", false).unwrap();
        assert_eq!(total, 1, "only the `ok` entry is eligible");
    }

    /// Locked entries are excluded when `include_protected` is false (the
    /// default), mirroring `list_entries_needing_index`'s scope exactly.
    #[test]
    fn count_total_entries_for_model_respects_protected_filter() {
        let conn = open_test_db();
        insert_test_entry(&conn, "open");
        insert_test_entry(&conn, "locked");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();

        let total_excluded = count_total_entries_for_model(&conn, "m", false).unwrap();
        assert_eq!(total_excluded, 1);

        let total_included = count_total_entries_for_model(&conn, "m", true).unwrap();
        assert_eq!(total_included, 2);
    }

    /// Regression: `count_indexed_entries_for_model` must apply the same
    /// protected filter as `count_total_entries_for_model`, so `indexed` can
    /// never exceed `total`. Before this fix, a locked entry with existing
    /// chunks (e.g. indexed while `ai_embed_include_protected` was on, then
    /// locked afterward) counted in `indexed` but was excluded from `total`,
    /// producing an impossible "Indexed 1 / total 0".
    #[test]
    fn count_indexed_entries_for_model_respects_protected_filter() {
        let conn = open_test_db();
        insert_test_entry(&conn, "open");
        insert_test_entry(&conn, "locked");
        upsert_chunk(&conn, "open", "m", 0, "h1", 0, 1, None, 1, &[0.1], 100).unwrap();
        upsert_chunk(&conn, "locked", "m", 0, "h2", 0, 1, None, 1, &[0.2], 100).unwrap();
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();

        let indexed_excluded = count_indexed_entries_for_model(&conn, "m", false).unwrap();
        let total_excluded = count_total_entries_for_model(&conn, "m", false).unwrap();
        assert_eq!(
            indexed_excluded, 1,
            "the locked entry must not count as indexed"
        );
        assert!(
            indexed_excluded <= total_excluded,
            "indexed ({indexed_excluded}) must never exceed total ({total_excluded})"
        );

        let indexed_included = count_indexed_entries_for_model(&conn, "m", true).unwrap();
        let total_included = count_total_entries_for_model(&conn, "m", true).unwrap();
        assert_eq!(indexed_included, 2);
        assert!(indexed_included <= total_included);
    }

    /// Clock skew: `indexed_at` sitting in the FUTURE relative to
    /// `entries.updated_at` (e.g. a device with a fast clock wrote the chunk
    /// row) must not crash the staleness comparison, and must resolve to
    /// "not stale" (a benign false negative — the entry just waits for a
    /// real edit to bump `updated_at` past the skewed `indexed_at`, it is
    /// never treated as perpetually needing index).
    #[test]
    fn list_entries_needing_index_handles_indexed_at_in_the_future_without_crashing() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        // entries.updated_at defaults to 0 (see insert_test_entry); indexed_at
        // is set far in the future, simulating clock skew.
        upsert_chunk(
            &conn,
            "e1",
            "m",
            0,
            "h",
            0,
            1,
            None,
            1,
            &[0.1],
            9_999_999_999,
        )
        .unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert!(
            needing.is_empty(),
            "a future indexed_at must not be treated as stale: {needing:?}"
        );
    }

    #[test]
    fn list_entries_needing_index_excludes_locked_and_invisible_when_not_include_protected() {
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "locked");
        insert_test_entry(&conn, "invisible");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
            [],
        )
        .unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert_eq!(
            needing,
            vec!["visible".to_string()],
            "locked/invisible entries must be excluded from write-eligibility by default"
        );
    }

    /// Regression (2026-08-04, live-debugged: footer stuck at "Waiting for
    /// edits to settle" with `pending: 1` forever): with
    /// `include_protected=true` this query used to gate BOTH exclusion
    /// predicates, surfacing invisible ids too — but every write-side
    /// consumer hard-blocks invisible entries unconditionally
    /// (`claim_due_embedding_jobs`'s bare predicate,
    /// `get_entry_for_provider`'s refusal in the opportunistic seeder), so
    /// an invisible entry was counted as "needing index" yet could never be
    /// claimed, embedded, or drained by anything. `include_protected` must
    /// grant write-eligibility to LOCKED entries only — the same asymmetry
    /// `list_chunks_for_sync_push` already implements.
    #[test]
    fn list_entries_needing_index_include_protected_surfaces_locked_but_never_invisible() {
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "locked");
        insert_test_entry(&conn, "invisible");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
            [],
        )
        .unwrap();

        let mut needing = list_entries_needing_index(&conn, "m", 10, true).unwrap();
        needing.sort();
        assert_eq!(
            needing,
            vec!["locked".to_string(), "visible".to_string()],
            "include_protected surfaces locked ids, but an invisible entry can never be \
             embedded, so listing it would leave `pending > 0` forever"
        );
    }

    #[test]
    fn count_total_entries_for_model_excludes_invisible_even_when_include_protected() {
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "locked");
        insert_test_entry(&conn, "invisible");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
            [],
        )
        .unwrap();

        assert_eq!(
            count_total_entries_for_model(&conn, "m", true).unwrap(),
            2,
            "total must count visible + locked only — an invisible entry can never be indexed"
        );
    }

    /// Chunk rows are deliberately KEPT when an entry becomes invisible (the
    /// read-side filter is the guarantee, not deletion) — so the indexed
    /// count must apply the same unconditional invisible exclusion, or an
    /// embedded-then-hidden entry inflates `indexed` above what `total` can
    /// ever reach.
    #[test]
    fn count_indexed_entries_for_model_excludes_invisible_even_when_include_protected() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e_hidden");
        upsert_chunk(&conn, "e_hidden", "m", 0, "h", 0, 1, None, 1, &[0.1], 100).unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'e_hidden'",
            [],
        )
        .unwrap();

        assert_eq!(
            count_indexed_entries_for_model(&conn, "m", true).unwrap(),
            0,
            "an embedded-then-hidden entry must drop out of the indexed count"
        );
    }

    /// The pre-fix version of this predicate (bare `NOT EXISTS` OR
    /// staleness) would keep listing a content-skipped entry forever: skip
    /// never advances `indexed_at`, so once the chunk-diff worker prunes its
    /// stale chunks (see `ai::indexer`'s skip resolution), a too-short entry
    /// with zero chunks would satisfy `NOT EXISTS` unconditionally — it
    /// needs the "latest job is skipped, no edit since" exclusion added
    /// alongside it to stop being listed.
    #[test]
    fn list_entries_needing_index_excludes_entry_skipped_with_no_edit_since() {
        let conn = open_test_db();
        insert_test_entry(&conn, "too_short");
        // Job resolved to `skipped` (mirrors `ai::indexer::skip_and_maybe_prune`
        // after it pruned the entry's chunk rows) at `updated_at = 200`, no
        // edit since (entry's own `updated_at` — from `insert_test_entry` —
        // is `0`, i.e. strictly older than the skip).
        mark_entry_embedding_dirty(&conn, "too_short", "m", "h", 0, 0).unwrap();
        skip_embedding_job(&conn, "too_short", "m", 200).unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert!(
            needing.is_empty(),
            "a chunk-less entry skipped with no edit since must not be re-listed: {needing:?}"
        );
    }

    /// A newer edit (bumping `updated_at` past the old skip's timestamp)
    /// must lift the skip-exclusion — otherwise an entry that grows back
    /// past `AI_ENTRY_EMBED_MIN_CHARS` would stay excluded forever.
    #[test]
    fn list_entries_needing_index_relists_entry_edited_after_a_skip() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        mark_entry_embedding_dirty(&conn, "e1", "m", "h", 0, 0).unwrap();
        skip_embedding_job(&conn, "e1", "m", 100).unwrap();
        conn.execute("UPDATE entries SET updated_at = 200 WHERE id = 'e1'", [])
            .unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert_eq!(
            needing,
            vec!["e1".to_string()],
            "an edit newer than the old skip must lift the exclusion"
        );
    }

    /// A locked entry with pre-existing (now stale) chunk rows must already
    /// be excluded regardless of staleness — the locked-exclusion predicate
    /// reads the entry's CURRENT lock state on every call, not a cached
    /// flag, so no additional query change is needed for the locked-skip
    /// cause (see the doc comment above `list_entries_needing_index`).
    #[test]
    fn list_entries_needing_index_excludes_locked_entry_even_when_stale() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h", 0, 1, None, 1, &[0.1], 100).unwrap();
        conn.execute(
            "UPDATE entries SET is_locked = 1, updated_at = 200 WHERE id = 'e1'",
            [],
        )
        .unwrap();

        let needing = list_entries_needing_index(&conn, "m", 10, false).unwrap();
        assert!(
            needing.is_empty(),
            "locked+stale must already be excluded: {needing:?}"
        );
    }

    // ── Cross-device sync push (Phase 5 Task 2) ─────────────────────────────

    #[test]
    fn embedding_sync_push_gathers_only_the_requested_model_id() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(
            &conn,
            "e1",
            "model-a",
            0,
            "hash-a0",
            0,
            1,
            None,
            2,
            &[1.0, 0.0],
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "e1",
            "model-b",
            0,
            "hash-b0",
            0,
            1,
            None,
            2,
            &[0.0, 1.0],
            0,
        )
        .unwrap();

        let rows = list_chunks_for_sync_push(&conn, "model-a", false).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "only the requested model's chunks are gathered"
        );
        assert_eq!(rows[0].model_id, "model-a");
        assert_eq!(rows[0].entry_id, "e1");
        assert_eq!(rows[0].content_hash, "hash-a0");
    }

    #[test]
    fn embedding_sync_push_excludes_locked_and_invisible_when_not_include_protected() {
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "locked");
        insert_test_entry(&conn, "invisible");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
            [],
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "visible",
            "m",
            0,
            "h-visible",
            0,
            1,
            None,
            1,
            &[0.1],
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "locked",
            "m",
            0,
            "h-locked",
            0,
            1,
            None,
            1,
            &[0.2],
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "invisible",
            "m",
            0,
            "h-invisible",
            0,
            1,
            None,
            1,
            &[0.3],
            0,
        )
        .unwrap();

        let rows = list_chunks_for_sync_push(&conn, "m", false).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.entry_id.clone()).collect::<Vec<_>>(),
            vec!["visible".to_string()],
            "locked/invisible entries' vectors must not be pushed by default"
        );
    }

    #[test]
    fn embedding_sync_push_includes_locked_but_still_excludes_invisible_when_include_protected() {
        // Asymmetric shape (mirrors `claim_due_embedding_jobs`): opting in to
        // include_protected surfaces LOCKED vectors, but INVISIBLE stays a
        // hard-never regardless of the setting.
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "locked");
        insert_test_entry(&conn, "invisible");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = 'invisible'",
            [],
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "visible",
            "m",
            0,
            "h-visible",
            0,
            1,
            None,
            1,
            &[0.1],
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "locked",
            "m",
            0,
            "h-locked",
            0,
            1,
            None,
            1,
            &[0.2],
            0,
        )
        .unwrap();
        upsert_chunk(
            &conn,
            "invisible",
            "m",
            0,
            "h-invisible",
            0,
            1,
            None,
            1,
            &[0.3],
            0,
        )
        .unwrap();

        let mut entry_ids: Vec<String> = list_chunks_for_sync_push(&conn, "m", true)
            .unwrap()
            .into_iter()
            .map(|r| r.entry_id)
            .collect();
        entry_ids.sort();
        assert_eq!(
            entry_ids,
            vec!["locked".to_string(), "visible".to_string()],
            "opting in to include_protected must surface locked vectors, but invisible must \
             remain excluded"
        );
    }

    #[test]
    fn embedding_sync_push_excludes_deleted_entries() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 1, &[0.1], 0).unwrap();
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e1'", [])
            .unwrap();

        let rows = list_chunks_for_sync_push(&conn, "m", false).unwrap();
        assert!(rows.is_empty(), "soft-deleted entries must not be pushed");
    }

    #[test]
    fn embedding_sync_push_row_never_carries_job_queue_fields() {
        // Schema guard mirroring `sync_chunks_never_include_job_queue_fields`
        // in `sync::embedding_sync`: `SyncableChunkVector` must only ever
        // carry `entry_embedding_chunks` fields, never dirty-queue state
        // (status/attempts/last_error/...).
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 1, &[0.1], 0).unwrap();
        mark_entry_embedding_dirty(&conn, "e1", "m", "h1", 0, 0).unwrap();

        let rows = list_chunks_for_sync_push(&conn, "m", false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0],
            SyncableChunkVector {
                entry_id: "e1".to_string(),
                model_id: "m".to_string(),
                chunk_index: 0,
                content_hash: "h1".to_string(),
                dim: 1,
                vec: vec_to_blob(&[0.1]),
            }
        );
    }

    #[test]
    fn embedding_sync_distinct_synced_model_ids_returns_sorted_unique_ids() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        upsert_chunk(&conn, "e1", "model-b", 0, "h1", 0, 1, None, 1, &[0.1], 0).unwrap();
        upsert_chunk(&conn, "e1", "model-a", 0, "h2", 0, 1, None, 1, &[0.2], 0).unwrap();
        upsert_chunk(&conn, "e1", "model-a", 1, "h3", 0, 1, None, 1, &[0.3], 0).unwrap();

        let ids = distinct_synced_model_ids(&conn).unwrap();
        assert_eq!(ids, vec!["model-a".to_string(), "model-b".to_string()]);
    }

    #[test]
    fn embedding_sync_distinct_synced_model_ids_empty_store_returns_empty() {
        let conn = open_test_db();
        assert!(distinct_synced_model_ids(&conn).unwrap().is_empty());
    }

    /// Regression guard for the real privacy boundary (Task 6): a chunk
    /// embedded while an entry was visible must not leak after the entry
    /// is locked. `retrieve_top_k` / `list_vectors_for_model` are
    /// deliberately filter-free (ranking layer) — the boundary lives in
    /// `fetch_entry_meta_with_locks`, which every read path (semantic
    /// search) routes through. This must hold regardless of
    /// `ai_embed_include_protected`, since that setting only affects
    /// write eligibility, never read-side filtering.
    #[test]
    fn locked_entry_embedded_while_visible_is_filtered_out_after_locking() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        // Entry was visible when it was embedded.
        upsert_chunk(&conn, "e1", "m", 0, "h1", 0, 1, None, 2, &[1.0, 0.0], 0).unwrap();

        // Still visible: the chunk shows up via the read-side gate.
        let before =
            fetch_entry_meta_with_locks(&conn, &["e1".to_string()], None, LockedView::Hidden, None)
                .unwrap();
        assert_eq!(before.len(), 1, "entry surfaces while still visible");

        // User locks the entry AFTER it was embedded.
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'e1'", [])
            .unwrap();

        // The stored chunk vector is untouched...
        assert_eq!(list_stored_chunks(&conn, "e1", "m").unwrap().len(), 1);

        // ...but the read-side gate must now filter it out whenever the
        // locked/hidden view is active, regardless of the embed-time
        // visibility.
        let after =
            fetch_entry_meta_with_locks(&conn, &["e1".to_string()], None, LockedView::Hidden, None)
                .unwrap();
        assert!(
            after.is_empty(),
            "a chunk embedded while visible must not leak after locking"
        );
    }

    #[test]
    fn fetch_entry_meta_returns_empty_for_empty_ids() {
        let conn = open_test_db();
        let r = fetch_entry_meta(&conn, &[], None).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn fetch_entry_meta_preserves_input_order_and_skips_missing() {
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        // Soft-delete e2 — fetch must skip it.
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e2'", [])
            .unwrap();

        let ids = vec!["e3".into(), "missing".into(), "e2".into(), "e1".into()];
        let metas = fetch_entry_meta(&conn, &ids, None).unwrap();
        let got_ids: Vec<&str> = metas.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(got_ids, vec!["e3", "e1"]);
    }

    // ── New filter tests ──────────────────────────────────────────────────────

    #[test]
    fn fetch_entry_meta_respects_none_filter() {
        // Passing None must behave identically to the no-filter path.
        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");

        let ids = vec!["e2".into(), "e1".into()];
        let metas = fetch_entry_meta(&conn, &ids, None).unwrap();
        let got_ids: Vec<&str> = metas.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(got_ids, vec!["e2", "e1"]);
    }

    #[test]
    fn fetch_entry_meta_excludes_invisible_entries_unless_revealed() {
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "entry_hidden");
        insert_test_entry(&conn, "journal_hidden");
        conn.execute(
            "UPDATE entries SET is_invisible = 1, vault_id = 'test-vault' WHERE id = 'entry_hidden'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE journals SET is_invisible = 1, vault_id = 'test-vault' WHERE id = 'j1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO journals (id, name, is_invisible, created_at, updated_at) \
             VALUES ('j2', 'J2', 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET journal_id = 'j2' WHERE id IN ('visible', 'entry_hidden')",
            [],
        )
        .unwrap();

        let ids = vec![
            "visible".into(),
            "entry_hidden".into(),
            "journal_hidden".into(),
        ];
        let hidden = fetch_entry_meta(&conn, &ids, None).unwrap();
        let hidden_ids: Vec<&str> = hidden.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(hidden_ids, vec!["visible"]);

        let revealed = fetch_entry_meta_with_locks(
            &conn,
            &ids,
            None,
            LockedView::Revealed,
            Some("test-vault"),
        )
        .unwrap();
        let revealed_ids: Vec<&str> = revealed.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(
            revealed_ids,
            vec!["visible", "entry_hidden", "journal_hidden"]
        );
    }

    #[test]
    fn fetch_entry_meta_excludes_locked_entries_unless_revealed() {
        let conn = open_test_db();
        insert_test_entry(&conn, "visible");
        insert_test_entry(&conn, "entry_locked");
        insert_test_entry(&conn, "journal_locked");
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = 'entry_locked'",
            [],
        )
        .unwrap();
        // Journal-level lock: put `journal_locked` in a second-locked journal.
        conn.execute(
            "INSERT INTO journals (id, name, is_locked, created_at, updated_at) \
             VALUES ('jlocked', 'JL', 1, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET journal_id = 'jlocked' WHERE id = 'journal_locked'",
            [],
        )
        .unwrap();

        let ids = vec![
            "visible".into(),
            "entry_locked".into(),
            "journal_locked".into(),
        ];

        // Hidden AND Covered both exclude second-locked entries (mirrors
        // keyword search — a semantic match must not leak a locked entry's
        // existence).
        for view in [LockedView::Hidden, LockedView::Covered] {
            let filtered = fetch_entry_meta_with_locks(&conn, &ids, None, view, None).unwrap();
            let filtered_ids: Vec<&str> = filtered.iter().map(|m| m.entry_id.as_str()).collect();
            assert_eq!(filtered_ids, vec!["visible"], "view={view:?}");
        }

        // Revealed surfaces everything.
        let revealed =
            fetch_entry_meta_with_locks(&conn, &ids, None, LockedView::Revealed, None).unwrap();
        let revealed_ids: Vec<&str> = revealed.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(
            revealed_ids,
            vec!["visible", "entry_locked", "journal_locked"]
        );
    }

    #[test]
    fn fetch_entry_meta_filters_by_emotion() {
        use crate::db::filters::{EmotionKey, SearchFilters};

        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        conn.execute("UPDATE entries SET emotion = 'good' WHERE id = 'e1'", [])
            .unwrap();
        conn.execute("UPDATE entries SET emotion = 'bad' WHERE id = 'e2'", [])
            .unwrap();
        // e3 left with NULL emotion.

        let filters = SearchFilters {
            emotions: Some(vec![EmotionKey::Good]),
            ..Default::default()
        };
        let ids = vec!["e1".into(), "e2".into(), "e3".into()];
        let metas = fetch_entry_meta(&conn, &ids, Some(&filters)).unwrap();
        let got_ids: Vec<&str> = metas.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(got_ids, vec!["e1"]);
    }

    #[test]
    fn fetch_entry_meta_filters_by_journal_ids() {
        use crate::db::filters::SearchFilters;

        let conn = open_test_db();
        // 'j1' is created by insert_test_entry; add a second journal.
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) \
             VALUES ('j2', 'J2', 0, 0)",
            [],
        )
        .unwrap();

        // Seed two entries — one per journal using raw SQL.
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) \
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date, \
             created_at, updated_at) VALUES ('ea', 'j1', 't', 'c', 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date, \
             created_at, updated_at) VALUES ('eb', 'j2', 't', 'c', 0, 0, 0)",
            [],
        )
        .unwrap();

        let filters = SearchFilters {
            journal_ids: Some(vec!["j1".into()]),
            ..Default::default()
        };
        let ids = vec!["ea".into(), "eb".into()];
        let metas = fetch_entry_meta(&conn, &ids, Some(&filters)).unwrap();
        let got_ids: Vec<&str> = metas.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(got_ids, vec!["ea"]);
    }

    #[test]
    fn fetch_entry_meta_preserves_input_order_with_filter() {
        use crate::db::filters::{EmotionKey, SearchFilters};

        let conn = open_test_db();
        insert_test_entry(&conn, "e1");
        insert_test_entry(&conn, "e2");
        insert_test_entry(&conn, "e3");
        // All three have 'good' emotion.
        conn.execute(
            "UPDATE entries SET emotion = 'good' WHERE id IN ('e1','e2','e3')",
            [],
        )
        .unwrap();

        let filters = SearchFilters {
            emotions: Some(vec![EmotionKey::Good]),
            ..Default::default()
        };
        // Input order is e3, e1, e2 — result must preserve that order.
        let ids = vec!["e3".into(), "e1".into(), "e2".into()];
        let metas = fetch_entry_meta(&conn, &ids, Some(&filters)).unwrap();
        let got_ids: Vec<&str> = metas.iter().map(|m| m.entry_id.as_str()).collect();
        assert_eq!(got_ids, vec!["e3", "e1", "e2"]);
    }

    // ── Cross-device sync pull + adopt-on-match (Phase 5 Task 3) ────────────

    fn insert_test_entry_with_text(conn: &Connection, id: &str, title: &str, content: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO journals (id, name, created_at, updated_at) \
             VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("seed journal");
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date,
                created_at, updated_at)
             VALUES (?1, 'j1', ?2, ?3, 0, 0, 0)",
            params![id, title, content],
        )
        .expect("insert entry");
    }

    /// This device's own chunk-map hash at `chunk_index` for `(title,
    /// content)` — exactly the computation `adopt_synced_chunk_vector` does
    /// internally, used here to build fixtures whose incoming
    /// `content_hash` is known to match (or, for mismatch tests, known to
    /// differ from) what the device would compute.
    fn local_chunk_hash(title: &str, content: &str, chunk_index: i64) -> String {
        let text = crate::ai::indexer::build_indexable_text(Some(title), Some(content));
        crate::ai::chunking::chunk_indexable_text(&text)
            .into_iter()
            .find(|c| c.chunk_index as i64 == chunk_index)
            .expect("chunk_index must exist for this fixture text")
            .content_hash
    }

    fn sample_incoming(
        entry_id: &str,
        model_id: &str,
        chunk_index: i64,
        content_hash: &str,
        vec_f32: &[f32],
    ) -> IncomingChunkVector {
        IncomingChunkVector {
            entry_id: entry_id.to_string(),
            model_id: model_id.to_string(),
            chunk_index,
            content_hash: content_hash.to_string(),
            dim: vec_f32.len() as i64,
            vec: vec_to_blob(vec_f32),
        }
    }

    #[test]
    fn embedding_sync_adopt_matching_model_and_hash_stores_vector_bit_exactly() {
        let conn = open_test_db();
        insert_test_entry_with_text(&conn, "e1", "t", "hello world");
        let hash = local_chunk_hash("t", "hello world", 0);
        let incoming = sample_incoming("e1", "m", 0, &hash, &[0.1, 0.2, 0.3]);

        let outcome = adopt_synced_chunk_vector(&conn, true, &incoming, false, 100).unwrap();
        assert_eq!(outcome, AdoptOutcome::Adopted);

        let stored = list_stored_chunks(&conn, "e1", "m").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].content_hash, hash);
        assert_eq!(
            stored[0].vec,
            vec![0.1, 0.2, 0.3],
            "vector must be bit-exact"
        );
    }

    #[test]
    fn embedding_sync_adopt_mismatched_model_is_ignored() {
        let conn = open_test_db();
        insert_test_entry_with_text(&conn, "e1", "t", "hello world");
        let hash = local_chunk_hash("t", "hello world", 0);
        let incoming = sample_incoming("e1", "other-model", 0, &hash, &[0.1, 0.2, 0.3]);

        // `is_active_model = false`: the caller already determined this
        // device isn't using "other-model" — never even reaches the hash
        // check.
        let outcome = adopt_synced_chunk_vector(&conn, false, &incoming, false, 100).unwrap();
        assert_eq!(outcome, AdoptOutcome::ModelMismatch);
        assert!(list_stored_chunks(&conn, "e1", "other-model")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn embedding_sync_adopt_mismatched_content_hash_is_ignored() {
        let conn = open_test_db();
        // This device's CURRENT content differs from whatever the peer had
        // when it computed the incoming vector — device re-embeds locally
        // instead of trusting a vector for content it no longer has.
        insert_test_entry_with_text(&conn, "e1", "t", "hello world, edited locally");
        let incoming = sample_incoming("e1", "m", 0, "stale-hash-from-peer", &[0.1, 0.2, 0.3]);

        let outcome = adopt_synced_chunk_vector(&conn, true, &incoming, false, 100).unwrap();
        assert_eq!(outcome, AdoptOutcome::HashMismatch);
        assert!(list_stored_chunks(&conn, "e1", "m").unwrap().is_empty());
    }

    #[test]
    fn embedding_sync_adopt_is_idempotent_on_second_adoption() {
        let conn = open_test_db();
        insert_test_entry_with_text(&conn, "e1", "t", "hello world");
        let hash = local_chunk_hash("t", "hello world", 0);
        let incoming = sample_incoming("e1", "m", 0, &hash, &[0.1, 0.2, 0.3]);

        adopt_synced_chunk_vector(&conn, true, &incoming, false, 100).unwrap();
        let outcome_again = adopt_synced_chunk_vector(&conn, true, &incoming, false, 200).unwrap();
        assert_eq!(
            outcome_again,
            AdoptOutcome::Adopted,
            "re-adopting the exact same vector must not error"
        );

        let stored = list_stored_chunks(&conn, "e1", "m").unwrap();
        assert_eq!(stored.len(), 1, "must not duplicate the row");
        assert_eq!(stored[0].vec, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn embedding_sync_adopt_rejects_malformed_vector_length() {
        let conn = open_test_db();
        insert_test_entry_with_text(&conn, "e1", "t", "hello world");
        let hash = local_chunk_hash("t", "hello world", 0);
        let mut incoming = sample_incoming("e1", "m", 0, &hash, &[0.1, 0.2, 0.3]);
        // Claims dim=3 (would need 12 bytes) but only ships 5 raw bytes.
        incoming.vec = vec![0u8; 5];

        let outcome = adopt_synced_chunk_vector(&conn, true, &incoming, false, 100).unwrap();
        assert_eq!(outcome, AdoptOutcome::Malformed);
        assert!(list_stored_chunks(&conn, "e1", "m").unwrap().is_empty());
    }

    #[test]
    fn embedding_sync_adopt_rejects_implausible_dim() {
        let conn = open_test_db();
        insert_test_entry_with_text(&conn, "e1", "t", "hello world");
        let hash = local_chunk_hash("t", "hello world", 0);
        let incoming = IncomingChunkVector {
            entry_id: "e1".to_string(),
            model_id: "m".to_string(),
            chunk_index: 0,
            content_hash: hash,
            dim: 1_000_000,
            vec: vec![0u8; 4_000_000],
        };

        let outcome = adopt_synced_chunk_vector(&conn, true, &incoming, false, 100).unwrap();
        assert_eq!(outcome, AdoptOutcome::Malformed);
        assert!(list_stored_chunks(&conn, "e1", "m").unwrap().is_empty());
    }

    #[test]
    fn embedding_sync_adopt_ignores_locked_entry_unless_opted_in() {
        let conn = open_test_db();
        insert_test_entry_with_text(&conn, "e1", "t", "hello world");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'e1'", [])
            .unwrap();
        let hash = local_chunk_hash("t", "hello world", 0);
        let incoming = sample_incoming("e1", "m", 0, &hash, &[0.1, 0.2, 0.3]);

        let outcome = adopt_synced_chunk_vector(&conn, true, &incoming, false, 100).unwrap();
        assert_eq!(outcome, AdoptOutcome::EntryNotEligible);
        assert!(list_stored_chunks(&conn, "e1", "m").unwrap().is_empty());

        let outcome_opted_in =
            adopt_synced_chunk_vector(&conn, true, &incoming, true, 100).unwrap();
        assert_eq!(outcome_opted_in, AdoptOutcome::Adopted);
    }
}
