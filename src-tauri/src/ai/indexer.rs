//! Indexer that converts entries → vectors → rows in `entry_embedding_chunks`.
//!
//! Entry points:
//! - [`EntryIndexer::index_one`] — index a single entry directly (used by
//!   tests / one-off callers; **not** wired from the save path — see
//!   `commands::entries::maybe_mark_entry_embedding_dirty_after_save`,
//!   which only marks entries dirty and never calls an embedding
//!   provider). Does real per-paragraph chunk diffing via
//!   [`plan_chunk_diff`] / [`write_chunk_diff`] — unchanged chunks reuse
//!   their stored vector, only new/changed chunks are embedded.
//! - [`EntryIndexer::index_claimed_job`] — process one row claimed from
//!   `entry_embedding_jobs` (see `db::embeddings::claim_due_embedding_jobs`):
//!   same diff algorithm, plus job status transitions
//!   (`complete_embedding_job` / `skip_embedding_job` /
//!   `reset_embedding_job_to_pending` / `pause_embedding_job` /
//!   `fail_embedding_job` with exponential backoff — see
//!   [`finish_claimed_job`]). Holds `conn` for the whole call, including
//!   the embed itself — fine for tests / a single in-memory connection.
//! - [`claim_and_plan_batch`] / [`finish_claimed_job`] — the split
//!   lock/embed/lock counterpart of `index_claimed_job` used by the
//!   production continuous worker (`commands::ai::run_backfill_loop`,
//!   Phase 2 Task 4): claim + plan under a short lock
//!   (`claim_and_plan_batch`), embed OUTSIDE any lock (caller's
//!   responsibility — the worker uses the async `AIProvider::embed`
//!   directly, never `Embedder`'s thread-blocking sync bridge, which
//!   would otherwise pin the `AppState` mutex across the HTTP round-trip),
//!   then write back under a fresh short lock (`finish_claimed_job`).
//!   `index_claimed_job` delegates its own post-embed policy to
//!   `finish_claimed_job` too, so there is one backoff/pause/write policy,
//!   not two.
//! - [`EntryIndexer::backfill`] — iterate every unindexed, non-deleted
//!   entry and embed it. Throttled, cancellable, emits progress. Legacy
//!   one-shot path, superseded at runtime by the continuous worker but
//!   kept for tests / one-off callers.
//! - [`plan_chunk_diff`] / [`write_chunk_diff`] — the shared chunk-diff
//!   algorithm. Every writer of `entry_embedding_chunks` in the chunk-diff
//!   worker (this module's `index_one`/`finish_claimed_job` and
//!   `commands::ai::run_backfill_loop`, which calls `finish_claimed_job`
//!   rather than writing chunks itself) routes through these two
//!   functions rather than upserting chunks independently.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ai::embedder::{DynEmbedder, SwappableEmbedder};
use crate::ai::error::AiError;
use crate::db::embeddings;

/// Terminal (per-pass) outcome of [`EntryIndexer::index_claimed_job`].
#[derive(Debug, Clone, PartialEq)]
pub enum JobOutcome {
    /// Diffed, embedded new/changed chunks, wrote the result, job → `indexed`.
    Completed {
        entry_id: String,
        embedded: usize,
        reused: usize,
    },
    /// Canonical text below `AI_ENTRY_EMBED_MIN_CHARS`, job → `skipped`.
    Skipped { entry_id: String },
    /// Entry changed again mid-embed (hash mismatch); results discarded,
    /// job → `pending` for the next claim.
    Retried { entry_id: String },
    /// The active embedding model changed mid-embed (provider/model swap);
    /// results discarded (never written under the stale model_id), job →
    /// `pending` under its OLD model_id. Nothing claims that row going
    /// forward under normal operation (the worker only claims the active
    /// model_id) — Task 6 owns enqueueing a fresh job for the NEW model.
    ModelChanged { entry_id: String },
    /// Embed call failed with a transient/provider error; job → `error`
    /// with a scheduled retry (exponential backoff — see
    /// [`finish_claimed_job`]).
    Failed { entry_id: String, error: String },
    /// Embed call failed with an auth/config-class error (bad API key,
    /// unconfigured/unsupported provider) that will never succeed on bare
    /// retry; job → `paused`, auto-retry stops until the entry is
    /// dirtied again (e.g. after the user fixes the provider).
    Paused { entry_id: String, error: String },
}

/// Backfill progress tick — one event per entry processed (success OR
/// skip). The frontend renders these into the "Indexing N / total" row.
#[derive(Debug, Clone)]
pub struct BackfillProgress {
    pub model_id: String,
    pub indexed: u64,
    pub total: u64,
    pub current_entry_id: String,
}

/// Default cooperative throttle delay between entries. Backfill is a
/// background best-effort task; we keep it gentle on CPU + battery. A3b
/// will honour `prefers-reduced-motion` to slow this down further.
pub const DEFAULT_BACKFILL_THROTTLE: Duration = Duration::from_millis(2000);

/// Build the canonical text used as the embedding input for an entry.
/// Format: `"{title}\n\n{content_text}"`. NULL fields collapse to empty
/// strings; entries with no content at all return an empty `String` and
/// are still indexed (their vector is the L2-normalised "empty hash" —
/// deterministic but not particularly meaningful).
pub fn build_indexable_text(title: Option<&str>, content_text: Option<&str>) -> String {
    let title = title.unwrap_or("").trim();
    let content = content_text.unwrap_or("").trim();
    if title.is_empty() {
        content.to_string()
    } else if content.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n\n{content}")
    }
}

/// Below this many characters of canonical indexable text (`title +
/// content_text`), an entry is skipped entirely rather than embedded — too
/// short to produce a meaningful chunk/vector. Shared by the save-path
/// dirty-marking hook (`commands::entries::maybe_mark_entry_embedding_dirty_after_save`)
/// and the chunk-diff worker's own skip path ([`plan_chunk_diff`]) so both
/// sides of the queue agree on what "too short to bother" means.
pub const AI_ENTRY_EMBED_MIN_CHARS: usize = 20;

/// One chunk queued for a fresh embed call — its content changed (or is
/// brand new), so no stored vector can be reused.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkEmbedTarget {
    pub chunk_index: i64,
    /// Text to feed the embedder — exactly the chunk's core text, the same
    /// bytes `content_hash` was computed from (see `ai::chunking` module
    /// docs: chunk text no longer carries a borrowed overlap prefix).
    pub text: String,
    pub content_hash: String,
    pub char_start: i64,
    pub char_end: i64,
    pub preview: String,
}

/// One chunk whose previously stored vector is reused verbatim — its
/// `content_hash` matched an existing stored row, so the only thing that
/// may have changed is `chunk_index` (a paragraph inserted/removed
/// elsewhere in the entry shifts later chunks without touching their
/// content). Zero provider calls for these.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkReuseTarget {
    pub chunk_index: i64,
    pub content_hash: String,
    pub char_start: i64,
    pub char_end: i64,
    pub preview: String,
    pub dim: usize,
    pub vec: Vec<f32>,
}

/// Result of [`plan_chunk_diff`] for one entry — everything needed to (a)
/// embed `to_embed` OUTSIDE any DB lock, then (b) write the result back via
/// [`write_chunk_diff`] under a fresh lock.
#[derive(Debug, Clone)]
pub struct ChunkDiffPlan {
    /// `content_hash` of the whole canonical text at plan time — used as
    /// the race-guard snapshot: if the entry's canonical hash has changed
    /// by the time the caller is ready to write, the write must be
    /// discarded (see module docs on `entry_embedding_jobs` race handling,
    /// hardened further in Phase 2 Task 5).
    pub whole_entry_hash: String,
    /// Character count of the whole canonical text — callers that gate on
    /// [`AI_ENTRY_EMBED_MIN_CHARS`] (e.g. [`EntryIndexer::index_claimed_job`])
    /// read this instead of re-fetching/rebuilding the text themselves.
    /// `plan_chunk_diff` itself does NOT apply this threshold — chunking
    /// a short-but-nonempty entry still produces a valid (if trivial)
    /// chunk map (see `ai::chunking` tests); "too short to bother with a
    /// provider call" is a job-processing policy, not a property of the
    /// diff.
    pub text_char_count: usize,
    pub to_embed: Vec<ChunkEmbedTarget>,
    pub to_reuse: Vec<ChunkReuseTarget>,
    /// Every chunk_index in the freshly recomputed chunk map (reuse +
    /// embed combined) — pass to `delete_chunks_not_in` after writing so
    /// chunks that no longer exist (entry shrank / paragraphs merged) are
    /// pruned, at zero provider cost. Empty when the canonical text itself
    /// is empty, which correctly deletes every stored chunk for the entry.
    pub keep_indices: Vec<i64>,
    /// C2 pre-embed guard: `true` iff the entry is currently locked AND
    /// `ai_embed_include_protected` is off. This is a PLAN-TIME SNAPSHOT
    /// only — it catches a lock landing AFTER claim-time filtering
    /// (`db::embeddings::claim_due_embedding_jobs`) but BEFORE `plan_chunk_diff`
    /// runs (both happen under the same short lock, so this window is
    /// narrow) — content-hash race guards do NOT catch this (locking
    /// doesn't change content). It does NOT by itself catch a lock landing
    /// AFTER planning but before THIS job's own (possibly much later,
    /// sequential) embed turn in a multi-job batch — that wider window is
    /// covered separately, immediately before each `provider.embed` call,
    /// by `entry_still_embed_eligible`. Invisible entries never reach this
    /// point at all: `get_entry_for_provider` (called above) already
    /// excludes them unconditionally. Callers MUST check this and skip the
    /// job (`skip_embedding_job`, zero provider calls) rather than
    /// embedding `to_embed` — see [`EntryIndexer::index_claimed_job`] /
    /// [`claim_and_plan_batch`].
    pub is_locked_excluded: bool,
}

/// Compute the chunk diff plan for `entry_id` against `model_id`'s
/// currently stored chunks: recomputes the chunk map from the entry's live
/// canonical text, then matches every new chunk against the stored set by
/// `content_hash` (never by `chunk_index` — a mid-entry paragraph insert
/// shifts every later index without changing their content, and matching
/// positionally would force an unnecessary re-embed of unrelated chunks;
/// see `db::embeddings` module docs).
///
/// Pure read — safe to call under a short-lived connection lock. Returns
/// `AiError::IoError` when the entry doesn't exist (deleted/invisible).
pub fn plan_chunk_diff(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
) -> Result<ChunkDiffPlan, AiError> {
    let entry = crate::db::queries::get_entry_for_provider(conn, entry_id)
        .map_err(|e| AiError::IoError(format!("read entry {entry_id}: {e}")))?
        .ok_or_else(|| {
            AiError::IoError(format!(
                "entry {entry_id} not found (deleted or invisible before index?)"
            ))
        })?;

    // C2 pre-embed guard: re-check lock state RIGHT NOW, not just whatever
    // passed the claim-time filter. `entry.is_locked` is the EFFECTIVE
    // lock (entry OR its journal — see `db::queries::ENTRY_COLUMNS_E_WITH_EFFECTIVE_LOCK`),
    // so this catches a journal-level lock too. Invisible entries never
    // reach here — `get_entry_for_provider` above already excludes them
    // unconditionally, regardless of `include_protected`.
    let is_locked_excluded = entry.is_locked && !read_include_protected(conn);

    let text = build_indexable_text(entry.title.as_deref(), entry.content_text.as_deref());
    let text_char_count = text.chars().count();
    let whole_entry_hash = crate::ai::chunking::content_hash(&text);
    let new_chunks = crate::ai::chunking::chunk_indexable_text(&text);

    let stored = embeddings::list_stored_chunks(conn, entry_id, model_id)
        .map_err(|e| AiError::IoError(format!("list stored chunks: {e}")))?;
    // Multiple stored rows can (rarely) share a content_hash — e.g. two
    // identical paragraphs. Any one of them is a valid reuse source since
    // identical normalized text always embeds to the same vector.
    let mut by_hash: std::collections::HashMap<String, embeddings::StoredChunk> =
        std::collections::HashMap::new();
    for c in stored {
        by_hash.entry(c.content_hash.clone()).or_insert(c);
    }

    let mut to_embed = Vec::new();
    let mut to_reuse = Vec::new();
    let mut keep_indices = Vec::with_capacity(new_chunks.len());
    for chunk in new_chunks {
        let chunk_index = chunk.chunk_index as i64;
        keep_indices.push(chunk_index);
        match by_hash.get(&chunk.content_hash) {
            Some(existing) => to_reuse.push(ChunkReuseTarget {
                chunk_index,
                content_hash: chunk.content_hash,
                char_start: chunk.char_start as i64,
                char_end: chunk.char_end as i64,
                preview: chunk.preview,
                dim: existing.dim,
                vec: existing.vec.clone(),
            }),
            None => to_embed.push(ChunkEmbedTarget {
                chunk_index,
                text: chunk.text,
                content_hash: chunk.content_hash,
                char_start: chunk.char_start as i64,
                char_end: chunk.char_end as i64,
                preview: chunk.preview,
            }),
        }
    }

    Ok(ChunkDiffPlan {
        whole_entry_hash,
        text_char_count,
        to_embed,
        to_reuse,
        keep_indices,
        is_locked_excluded,
    })
}

/// Write a [`ChunkDiffPlan`]'s result: upsert every reused chunk (vector
/// carried over, only `chunk_index` may differ) and every freshly embedded
/// chunk, then prune anything no longer in `plan.keep_indices`. `embedded`
/// must be parallel to `plan.to_embed` (same length, same order) — the
/// caller embeds `plan.to_embed[i].text` OUTSIDE the DB lock and passes the
/// resulting vector at `embedded[i]`.
///
/// This is the single write path for chunk-diff results — [`EntryIndexer::index_one`],
/// the backfill loop (`commands::ai::run_backfill_loop`), and the on-demand
/// emotion-suggest cache-miss path (`commands::ai::suggest_emotion_inner`)
/// all route through this function rather than writing
/// `entry_embedding_chunks` independently.
pub fn write_chunk_diff(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    plan: &ChunkDiffPlan,
    embedded: &[Vec<f32>],
    indexed_at: i64,
) -> Result<(), AiError> {
    if embedded.len() != plan.to_embed.len() {
        return Err(AiError::IoError(format!(
            "write_chunk_diff: embedded vectors ({}) != planned targets ({}) for entry {entry_id}",
            embedded.len(),
            plan.to_embed.len()
        )));
    }
    for (target, vec) in plan.to_embed.iter().zip(embedded.iter()) {
        embeddings::upsert_chunk(
            conn,
            entry_id,
            model_id,
            target.chunk_index,
            &target.content_hash,
            target.char_start,
            target.char_end,
            Some(&target.preview),
            vec.len(),
            vec,
            indexed_at,
        )
        .map_err(|e| AiError::IoError(format!("upsert embedded chunk: {e}")))?;
    }
    for target in &plan.to_reuse {
        embeddings::upsert_chunk(
            conn,
            entry_id,
            model_id,
            target.chunk_index,
            &target.content_hash,
            target.char_start,
            target.char_end,
            Some(&target.preview),
            target.dim,
            &target.vec,
            indexed_at,
        )
        .map_err(|e| AiError::IoError(format!("upsert reused chunk: {e}")))?;
    }
    embeddings::delete_chunks_not_in(conn, entry_id, model_id, &plan.keep_indices)
        .map_err(|e| AiError::IoError(format!("prune stale chunks: {e}")))?;
    Ok(())
}

/// Claim up to `dirty_limit` due dirty jobs for `model_id`; when none are
/// due, opportunistically seed + claim up to `opportunistic_limit`
/// never-embedded entries (recency-first) so idle app-open time is put to
/// use. Pure DB work — shared by [`EntryIndexer::process_worker_batch`]
/// (single-connection convenience) and [`claim_and_plan_batch`] (the
/// production split lock/embed/lock path) so there is exactly one
/// claim/seed algorithm. See [`EntryIndexer::process_worker_batch`]'s docs
/// for the full opportunistic-seeding rationale (never yanks a
/// mid-debounce entry forward).
/// Read `ai_embed_include_protected` — `true` when locked entries are
/// write-eligible (invisible entries are a separate, unconditional
/// exclusion — see `db::embeddings` module docs). Missing/unreadable
/// settings row fails CLOSED (`false`) so a DB hiccup can never silently
/// start including protected entries. Shared by every call site that used
/// to duplicate this exact read: [`claim_batch_jobs`],
/// [`enqueue_dirty_jobs_for_model`], [`plan_chunk_diff`], and
/// [`EntryIndexer::backfill`].
fn read_include_protected(conn: &Connection) -> bool {
    crate::db::queries::get_setting(
        conn,
        crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
    )
    .ok()
    .flatten()
    .map(|s| s == "true")
    .unwrap_or(false)
}

fn claim_batch_jobs(
    conn: &Connection,
    model_id: &str,
    dirty_limit: usize,
    opportunistic_limit: usize,
) -> Result<Vec<embeddings::EmbeddingJobRow>, AiError> {
    let now = chrono::Utc::now().timestamp();
    let include_protected = read_include_protected(conn);
    let due =
        embeddings::claim_due_embedding_jobs(conn, model_id, dirty_limit, now, include_protected)
            .map_err(|e| AiError::IoError(format!("claim_due_embedding_jobs: {e}")))?;
    if !due.is_empty() {
        return Ok(due);
    }

    // Never-indexed rows from `list_entries_needing_index` are sync-origin.
    // Modal Pause (`pause_scope=sync_backfill`) must not opportunistic-seed
    // them; already-queued LocalDirty jobs were claimed above.
    if !opportunistic_untracked_seed_allowed(conn) {
        return Ok(Vec::new());
    }

    let candidates = embeddings::list_entries_needing_index(
        conn,
        model_id,
        opportunistic_limit,
        include_protected,
    )
    .map_err(|e| AiError::IoError(format!("list_entries_needing_index: {e}")))?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    for entry_id in &candidates {
        seed_dirty_job_if_untracked(conn, entry_id, model_id, now)?;
    }

    // Claim right back — same `now`, so these freshly-seeded jobs are
    // immediately due. Recency order survives: `claim_due_embedding_jobs`
    // orders by the owning entry's `updated_at DESC` first, `dirty_at`
    // only as a tiebreaker (and every seeded job shares this pass's
    // `dirty_at`, so it never overrides recency).
    embeddings::claim_due_embedding_jobs(
        conn,
        model_id,
        opportunistic_limit,
        now,
        include_protected,
    )
    .map_err(|e| AiError::IoError(format!("claim_due_embedding_jobs (opportunistic): {e}")))
}

/// Mark one entry dirty for `model_id`, unless it's deleted/invisible or
/// already has a tracked, non-stale job row. Shared by [`claim_batch_jobs`]'s
/// opportunistic seeding and [`enqueue_dirty_jobs_for_model`] (Phase 2
/// Task 6) so there is one seed-a-job algorithm, not two.
///
/// A candidate with an existing `pending`/`in_progress`/`error`/`paused`/
/// `skipped` job row is mid-quiet-window (or otherwise already tracked on
/// its own schedule) and must keep waiting its own debounce, never get
/// yanked forward just because it also matched `list_entries_needing_index`.
///
/// **C11 fix:** an `indexed` job row is the ONE exception — since
/// `list_entries_needing_index` now surfaces entries whose content changed
/// AFTER their `indexed` chunk rows were written (not just entries with zero
/// chunk rows), a candidate with an `indexed` row is exactly the "switched
/// back to a previously-used model whose stored vectors are now stale" case.
/// Treating it as "already tracked, skip" the way every other status is
/// treated would silently defeat the widened staleness check — an `indexed`
/// job never retries on its own, so nothing else would ever re-mark it dirty.
///
/// Returns `true` iff a job row was created or an existing `indexed` row was
/// re-marked dirty.
fn opportunistic_untracked_seed_allowed(conn: &Connection) -> bool {
    match crate::ai::embedding_decision::read_embed_sync_decision(
        conn,
        crate::ai::embedding_decision::EmbedSyncSlot::Entry,
    ) {
        Ok(d) => crate::ai::embedding_decision::auto_index_allowed(
            &d,
            crate::ai::embedding_decision::AutoIndexScope::SyncBackfill,
        ),
        Err(_) => false,
    }
}

fn seed_dirty_job_if_untracked(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    now: i64,
) -> Result<bool, AiError> {
    if let Some(job) = embeddings::get_embedding_job(conn, entry_id, model_id)
        .map_err(|e| AiError::IoError(format!("get_embedding_job: {e}")))?
    {
        if job.status != "indexed" {
            return Ok(false);
        }
    }
    let entry = match crate::db::queries::get_entry_for_provider(conn, entry_id) {
        Ok(Some(e)) => e,
        Ok(None) => return Ok(false), // deleted/invisible between list + seed — skip
        Err(e) => {
            return Err(AiError::IoError(format!(
                "read entry {entry_id} for dirty-job seed: {e}"
            )))
        }
    };
    let text = build_indexable_text(entry.title.as_deref(), entry.content_text.as_deref());
    let hash = crate::ai::chunking::content_hash(&text);
    embeddings::mark_entry_embedding_dirty(conn, entry_id, model_id, &hash, now, now)
        .map_err(|e| AiError::IoError(format!("mark_entry_embedding_dirty: {e}")))?;
    Ok(true)
}

/// Re-enqueue every eligible, not-yet-indexed entry as a dirty job for
/// `model_id` — Phase 2 Task 6: called by `commands::ai_provider::
/// apply_embedding_slot_change` when the embedding slot's identity
/// (`provider_id:embedding_model`) actually changes and an embedding-
/// consuming feature is enabled, so the continuous worker
/// ([`crate::commands::ai::run_backfill_loop`]) starts draining the NEW
/// model's queue immediately instead of waiting for its own opportunistic-
/// seeding batch (a handful of entries per tick) to discover them.
///
/// Uses the same `list_entries_needing_index` anti-join + `include_protected`
/// convention as `claim_batch_jobs`'s opportunistic seeding — recency-first,
/// and entries already indexed under `model_id` (e.g. switching back to a
/// model that already has stored chunks) are excluded, so this never
/// re-embeds work that's already done for the new identity. Jobs already
/// queued for the OLD model_id are untouched — `entry_embedding_jobs` is
/// keyed by `(entry_id, model_id)`, so nothing here reads, claims, or
/// deletes them.
///
/// This only writes `pending` job rows — zero provider calls. Whether the
/// worker is actually allowed to drain them (hosted-without-consent) is
/// decided per-tick by `background_indexing_allowed`, not here.
pub fn enqueue_dirty_jobs_for_model(conn: &Connection, model_id: &str) -> Result<usize, AiError> {
    enqueue_dirty_jobs_for_model_filtered(conn, model_id, None)
}

/// Like [`enqueue_dirty_jobs_for_model`], but when `only_entry_ids` is
/// `Some` only those ids are considered (hash/model-mismatch re-embed).
/// `None` keeps the full-model seed used on slot change.
pub fn enqueue_dirty_jobs_for_model_filtered(
    conn: &Connection,
    model_id: &str,
    only_entry_ids: Option<&std::collections::HashSet<String>>,
) -> Result<usize, AiError> {
    let include_protected = read_include_protected(conn);
    let candidates = embeddings::list_entries_needing_index(
        conn,
        model_id,
        i64::MAX as usize,
        include_protected,
    )
    .map_err(|e| AiError::IoError(format!("list_entries_needing_index: {e}")))?;

    let now = chrono::Utc::now().timestamp();
    let mut enqueued = 0usize;
    for entry_id in &candidates {
        if let Some(only) = only_entry_ids {
            if !only.contains(entry_id) {
                continue;
            }
        }
        if seed_dirty_job_if_untracked(conn, entry_id, model_id, now)? {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

/// Resolve a skipped job (`skip_embedding_job`), pruning the entry's stale
/// chunk rows first when the skip cause is "no embeddable content under
/// this model any more" (below [`AI_ENTRY_EMBED_MIN_CHARS`]) — otherwise the
/// entry's pre-edit vectors would keep being served by retrieval, AND
/// `db::embeddings::list_entries_needing_index`'s bare `NOT EXISTS` branch
/// would just take over from the staleness branch and keep re-listing it
/// forever (see that function's doc comment). Uses the same zero-provider-
/// cost prune path as [`write_chunk_diff`]'s cleanup step
/// (`delete_chunks_not_in` with an empty keep set deletes every stored
/// chunk for `(entry_id, model_id)`).
///
/// A locked-excluded skip (`plan.is_locked_excluded`, entry locked while
/// `ai_embed_include_protected` is off) does NOT prune — keeping vectors
/// for an entry locked after embedding is documented design (the read-side
/// lock filter is the guarantee, not deletion — see
/// `docs/plans/2026-07-06-embedding-cost-guardrails/embedding-lifecycle.md`),
/// and `list_entries_needing_index` already excludes a currently-locked
/// entry regardless of staleness, so no query-side fix was needed for this
/// cause either.
fn skip_and_maybe_prune(
    conn: &Connection,
    entry_id: &str,
    model_id: &str,
    plan: &ChunkDiffPlan,
    now: i64,
) -> Result<(), AiError> {
    if plan.text_char_count < AI_ENTRY_EMBED_MIN_CHARS {
        embeddings::delete_chunks_not_in(conn, entry_id, model_id, &[])
            .map_err(|e| AiError::IoError(format!("prune stale chunks on skip: {e}")))?;
    }
    embeddings::skip_embedding_job(conn, entry_id, model_id, now)
        .map_err(|e| AiError::IoError(format!("skip_embedding_job: {e}")))
}

/// One claimed job paired with its (already-planned) chunk diff — the
/// result of [`claim_and_plan_batch`]'s lock-held "claim + plan" phase.
/// `plan.to_embed` is embedded OUTSIDE any DB lock by the caller; the
/// result is written back via [`finish_claimed_job`] under a fresh short
/// lock. This is the split-lock counterpart of
/// [`EntryIndexer::index_claimed_job`], which does the same work but holds
/// `conn` (and therefore, in production, the `AppState` mutex) across the
/// embed call too — safe only for tests / single-connection callers.
#[derive(Debug, Clone)]
pub struct ClaimedJobPlan {
    pub job: embeddings::EmbeddingJobRow,
    pub plan: ChunkDiffPlan,
}

/// Lock-held phase 1 of the production split lock/embed/lock pattern
/// (Phase 2 Task 4): gate + claim + plan, entirely DB-only work, safe
/// under a short-lived connection lock. Too-short/empty entries, and
/// entries that became locked between claim-time filtering and this plan
/// (C2's pre-embed guard — see `ChunkDiffPlan::is_locked_excluded`), are
/// resolved immediately (`skip_embedding_job`, zero provider calls) since
/// planning already knows both. Callers embed each returned plan's
/// `to_embed` OUTSIDE any lock, then write results back via
/// [`finish_claimed_job`].
///
/// Returns `Ok(Vec::new())` with zero DB writes beyond the consent check
/// when [`crate::commands::ai_settings::entry_embed_auto_allowed`] is
/// false this tick — a job already sitting in the dirty queue from an
/// earlier save must not be drained just because it got there before
/// consent was revoked, the feature was toggled off, or an embed-sync
/// decision (`pending`, or Pause with `pause_scope=all`) is still unresolved.
pub fn claim_and_plan_batch(
    conn: &Connection,
    model_id: &str,
    dirty_limit: usize,
    opportunistic_limit: usize,
) -> Result<Vec<ClaimedJobPlan>, AiError> {
    if !crate::commands::ai_settings::entry_embed_auto_allowed(conn) {
        return Ok(Vec::new());
    }
    let claimed = claim_batch_jobs(conn, model_id, dirty_limit, opportunistic_limit)?;
    let now = chrono::Utc::now().timestamp();
    let mut out = Vec::with_capacity(claimed.len());
    for job in claimed {
        let plan = plan_chunk_diff(conn, &job.entry_id, &job.model_id)?;
        if plan.text_char_count < AI_ENTRY_EMBED_MIN_CHARS || plan.is_locked_excluded {
            skip_and_maybe_prune(conn, &job.entry_id, &job.model_id, &plan, now)?;
            continue;
        }
        out.push(ClaimedJobPlan { job, plan });
    }
    Ok(out)
}

/// Exponential backoff schedule (Phase 2 Task 4): 1m / 5m / 15m / 1h+ for
/// the Nth failed attempt, where `attempt_count` is the job's attempt
/// count AFTER this failure is recorded (1-indexed — the first failure
/// evaluates `attempt_count == 1`). `pub(crate)` so `commands::ai`'s I3/I5
/// tick-abort path (`run_worker_tick_inner`) reuses the SAME schedule when
/// backing off the jobs it had to abandon mid-batch, rather than inventing
/// a second one.
pub(crate) fn backoff_secs_for_attempt(attempt_count: i64) -> i64 {
    match attempt_count {
        n if n <= 1 => 60,
        2 => 300,
        3 => 900,
        _ => 3600,
    }
}

/// `true` for error classes that will never succeed on bare retry — the
/// user must re-enter a key or reconfigure the provider. These stop
/// auto-retry (job → `paused`) instead of burning the exponential backoff
/// schedule on a call that's guaranteed to fail again next tick.
///
/// `pub(crate)` so `ai::providers::on_device_embed`'s tests can assert
/// against the exact predicate the worker uses, instead of duplicating
/// the classification logic.
pub(crate) fn is_auth_or_config_error(e: &AiError) -> bool {
    matches!(
        e,
        AiError::AuthFailed
            | AiError::ProviderNotConfigured
            | AiError::ProviderUnsupported(_)
            | AiError::ModelNotReady(_)
    )
}

/// Pre-embed per-entry eligibility re-check (C2 residual fix, round-2
/// review): `false` iff the entry is gone (deleted/invisible — mirrors
/// `get_entry_for_provider`'s unconditional exclusion) OR currently
/// locked with `ai_embed_include_protected` off — the exact same
/// asymmetry `plan_chunk_diff`'s `is_locked_excluded` snapshot applies,
/// but read FRESH, immediately before this job's own `provider.embed`
/// call.
///
/// **Why this exists in addition to `is_locked_excluded`:** in the
/// production split-lock worker, `claim_and_plan_batch` plans an ENTIRE
/// batch (up to several jobs) under one lock, then embeds each job
/// sequentially, one real HTTP round-trip at a time, OUTSIDE that lock.
/// `is_locked_excluded` is a snapshot taken once, for the whole batch, at
/// plan time — it cannot see a lock/invisibility that lands on a LATER
/// job's entry while an EARLIER job in the same batch is still embedding.
/// `commands::ai::run_worker_tick_inner` calls this function right before
/// every job's `provider.embed`, under the same short-lived connection
/// lock it already uses to re-check the gates — so a job whose entry
/// became ineligible mid-batch is skipped with ZERO `embed` calls, not
/// merely un-persisted after transmission (which is all
/// `finish_claimed_job`'s write-time guard can do, since by the time it
/// runs the plaintext has already left the process).
pub(crate) fn entry_still_embed_eligible(
    conn: &Connection,
    entry_id: &str,
) -> Result<bool, AiError> {
    let entry = crate::db::queries::get_entry_for_provider(conn, entry_id)
        .map_err(|e| AiError::IoError(format!("read entry {entry_id}: {e}")))?;
    Ok(match entry {
        None => false,
        Some(e) => !(e.is_locked && !read_include_protected(conn)),
    })
}

/// Read the entry's CURRENT canonical whole-entry hash + effective lock
/// state straight from the DB (Phase 2 Task 5's hardened race guard) — as
/// opposed to `plan.whole_entry_hash` / `plan.is_locked_excluded`, both
/// snapshots taken back when the job was planned, before the (possibly
/// slow) embed call. `Ok(None)` means the entry is gone (deleted, or
/// soft-deleted/invisible) by write time.
///
/// **C2 hardened guard:** the returned `is_locked` is the EFFECTIVE lock
/// (entry OR journal — `db::queries::ENTRY_COLUMNS_E_WITH_EFFECTIVE_LOCK`).
/// In the production split-lock worker, `claim_and_plan_batch` plans an
/// ENTIRE batch under one lock, then embeds each job sequentially — each a
/// real HTTP round-trip. A lock landing after the batch was planned but
/// before THIS job's own turn is not caught by
/// `ChunkDiffPlan::is_locked_excluded` (a plan-time snapshot for the whole
/// batch); [`finish_claimed_job`] re-checks it here, at write time, the
/// same way it already re-checks deletion.
///
/// `pub(crate)`: also reused by `commands::ai::suggest_emotion_inner`'s own
/// write-time re-check — the on-demand emotion-suggest path drops the DB
/// lock for its `provider.embed` call exactly the way the worker does, so
/// it needs the identical write-time guard before persisting chunk rows,
/// not a second hand-rolled copy of this query.
pub(crate) fn current_whole_entry_hash_and_lock(
    conn: &Connection,
    entry_id: &str,
) -> Result<Option<(String, bool)>, AiError> {
    let entry = crate::db::queries::get_entry_for_provider(conn, entry_id)
        .map_err(|e| AiError::IoError(format!("read entry {entry_id}: {e}")))?;
    Ok(entry.map(|e| {
        let text = build_indexable_text(e.title.as_deref(), e.content_text.as_deref());
        (crate::ai::chunking::content_hash(&text), e.is_locked)
    }))
}

/// Lock-held phase 2 of the production split lock/embed/lock pattern: write
/// the result of embedding a [`ClaimedJobPlan`]'s `to_embed` targets.
/// `embedded` is `Ok(vectors)` (parallel to `plan.to_embed`) when the embed
/// call outside the lock succeeded, or `Err(AiError)` when it failed.
/// `active_model_id` is the embedding model_id in effect RIGHT NOW (read
/// fresh by the caller, after the embed call returned) — compared against
/// `claimed.job.model_id` (the model_id the job was claimed/planned under)
/// to detect a provider/model swap that landed mid-embed.
///
/// Single source of truth for the post-embed policy, shared by
/// [`EntryIndexer::index_claimed_job`] (single-connection path) and the
/// production worker loop (`commands::ai::run_backfill_loop`):
/// - Embed failed with an auth/config-class error ([`is_auth_or_config_error`])
///   → `pause_embedding_job` — auto-retry stops.
/// - Embed failed with any other error → `fail_embedding_job` with
///   [`backoff_secs_for_attempt`]'s schedule.
/// - Entry's canonical hash already looked stale when the job was claimed
///   (dirty-time hash ≠ plan-time hash — a light guard from Task 2/4) →
///   discard, `reset_embedding_job_to_pending`.
/// - The active embedding model changed mid-embed (`claimed.job.model_id`
///   ≠ `active_model_id`) → discard; the stale-model vectors are never
///   written, the old job never completes — see [`JobOutcome::ModelChanged`].
/// - Entry's CURRENT canonical hash (read fresh here, not the plan-time
///   snapshot) ≠ `plan.whole_entry_hash` (edited again during the embed
///   call itself — the race window Task 5 hardens) → discard, reset to
///   `pending` with the LATEST hash.
/// - None of the above and embed succeeded → the single write path
///   ([`write_chunk_diff`]), then `complete_embedding_job`.
pub fn finish_claimed_job(
    conn: &Connection,
    claimed: &ClaimedJobPlan,
    active_model_id: &str,
    embedded: Result<Vec<Vec<f32>>, AiError>,
) -> Result<JobOutcome, AiError> {
    let now = chrono::Utc::now().timestamp();
    let entry_id = &claimed.job.entry_id;
    let model_id = &claimed.job.model_id;
    let plan = &claimed.plan;

    let embedded = match embedded {
        Ok(v) => v,
        Err(e) => {
            if is_auth_or_config_error(&e) {
                embeddings::pause_embedding_job(conn, entry_id, model_id, &e.to_string(), now)
                    .map_err(|e| AiError::IoError(format!("pause_embedding_job: {e}")))?;
                return Ok(JobOutcome::Paused {
                    entry_id: entry_id.clone(),
                    error: e.to_string(),
                });
            }
            let next_attempt_at = now + backoff_secs_for_attempt(claimed.job.attempt_count + 1);
            embeddings::fail_embedding_job(
                conn,
                entry_id,
                model_id,
                &e.to_string(),
                next_attempt_at,
                now,
            )
            .map_err(|e| AiError::IoError(format!("fail_embedding_job: {e}")))?;
            return Ok(JobOutcome::Failed {
                entry_id: entry_id.clone(),
                error: e.to_string(),
            });
        }
    };

    // Light race guard (Task 2/4): re-check the entry's hash-at-plan-time
    // against the job's dirty-time snapshot. A mismatch means the entry had
    // already changed again by the time it was claimed/planned — discard
    // these (now stale) results rather than persisting chunks for content
    // that's already superseded.
    if claimed.job.content_hash != plan.whole_entry_hash {
        embeddings::reset_embedding_job_to_pending(
            conn,
            entry_id,
            model_id,
            &plan.whole_entry_hash,
            now,
            now,
        )
        .map_err(|e| AiError::IoError(format!("reset_embedding_job_to_pending: {e}")))?;
        return Ok(JobOutcome::Retried {
            entry_id: entry_id.clone(),
        });
    }

    // Hardened guard (Task 5): the active embedding model changed while we
    // were embedding OUTSIDE the lock. Writing these vectors under the OLD
    // model_id would be technically valid data, but it silently completes
    // a job the user has effectively abandoned by switching providers —
    // discard and leave the old job for Task 6's provider-change enqueue
    // (or a future re-dirty) to deal with, never `complete_embedding_job`.
    if model_id != active_model_id {
        embeddings::reset_embedding_job_to_pending(
            conn,
            entry_id,
            model_id,
            &claimed.job.content_hash,
            now,
            now,
        )
        .map_err(|e| AiError::IoError(format!("reset_embedding_job_to_pending: {e}")))?;
        return Ok(JobOutcome::ModelChanged {
            entry_id: entry_id.clone(),
        });
    }

    // Hardened guard (Task 5): re-read the entry's CURRENT canonical hash —
    // as opposed to the two checks above (which only compare snapshots
    // taken before the embed call), this catches an edit landing DURING
    // the (possibly slow) embed itself, the race window the split
    // lock/embed/lock production path (`commands::ai::run_worker_tick_inner`)
    // actually exposes.
    match current_whole_entry_hash_and_lock(conn, entry_id)? {
        None => {
            // Entry deleted/invisible by write time — nothing left to
            // write chunks for; treat like the min-chars skip path rather
            // than erroring the whole tick.
            embeddings::skip_embedding_job(conn, entry_id, model_id, now)
                .map_err(|e| AiError::IoError(format!("skip_embedding_job: {e}")))?;
            return Ok(JobOutcome::Skipped {
                entry_id: entry_id.clone(),
            });
        }
        // C2 hardened guard: a lock landed DURING this job's own embed
        // call (started after `entry_still_embed_eligible`'s pre-embed
        // check in `commands::ai::run_worker_tick_inner` already passed) —
        // `plan.is_locked_excluded` cannot see this either way, since it's
        // a snapshot taken before ANY job in the batch was embedded. The
        // pre-embed check closes the window BETWEEN planning and this
        // job's turn (so the plaintext is never transmitted for a lock
        // that lands there); this write-time check is what's left: a lock
        // landing WHILE the HTTP round-trip for THIS job is already in
        // flight. Discard the freshly-embedded results without writing
        // them, exactly like the deleted-mid-embed case above.
        Some((_, is_locked)) if is_locked && !read_include_protected(conn) => {
            embeddings::skip_embedding_job(conn, entry_id, model_id, now)
                .map_err(|e| AiError::IoError(format!("skip_embedding_job: {e}")))?;
            return Ok(JobOutcome::Skipped {
                entry_id: entry_id.clone(),
            });
        }
        Some((current_hash, _)) if current_hash != plan.whole_entry_hash => {
            embeddings::reset_embedding_job_to_pending(
                conn,
                entry_id,
                model_id,
                &current_hash,
                now,
                now,
            )
            .map_err(|e| AiError::IoError(format!("reset_embedding_job_to_pending: {e}")))?;
            return Ok(JobOutcome::Retried {
                entry_id: entry_id.clone(),
            });
        }
        Some(_) => {}
    }

    write_chunk_diff(conn, entry_id, model_id, plan, &embedded, now)?;
    embeddings::complete_embedding_job(conn, entry_id, model_id, now)
        .map_err(|e| AiError::IoError(format!("complete_embedding_job: {e}")))?;
    Ok(JobOutcome::Completed {
        entry_id: entry_id.clone(),
        embedded: plan.to_embed.len(),
        reused: plan.to_reuse.len(),
    })
}

/// Indexer that owns a hot-swappable embedding service and writes through
/// to `entry_embedding_chunks`. Cheap to clone (Arc internally).
///
/// The embedder is stored as `Arc<SwappableEmbedder>` so the runtime can
/// swap the backend at any point (Stub → ONNX on opt-in, ONNX → Stub on
/// app lock + grace) without rebuilding the indexer's Tauri-managed
/// state. Both `index_one` and `backfill` resolve the active model id
/// via [`SwappableEmbedder::current_model_id`] so they always operate
/// on the live backend.
#[derive(Clone)]
pub struct EntryIndexer {
    embedder: Arc<SwappableEmbedder>,
    throttle: Duration,
}

impl EntryIndexer {
    pub fn new(embedder: Arc<SwappableEmbedder>) -> Self {
        Self {
            embedder,
            throttle: DEFAULT_BACKFILL_THROTTLE,
        }
    }

    /// Build an indexer wrapping `inner` in a fresh [`SwappableEmbedder`].
    /// Convenience for tests + the startup path that begins with a
    /// [`crate::ai::embedder::StubEmbedder`] before the user opts in.
    pub fn from_dyn(inner: DynEmbedder) -> Self {
        Self::new(Arc::new(SwappableEmbedder::new(inner)))
    }

    /// Override the per-entry throttle. Use `Duration::ZERO` in tests so
    /// they don't sleep 2s between entries.
    pub fn with_throttle(mut self, throttle: Duration) -> Self {
        self.throttle = throttle;
        self
    }

    /// Convenience: build an indexer backed by [`crate::ai::embedder::StubEmbedder`].
    /// A3b-1b will swap the inner to an ONNX-backed embedder via
    /// [`Self::swappable`].
    pub fn with_stub() -> Self {
        Self::from_dyn(Arc::new(
            crate::ai::embedder::StubEmbedder::default_for_dev(),
        ))
    }

    /// Handle to the swappable wrapper. Used by `init_embedding_service` /
    /// `dispose_embedding_service` Tauri commands to hot-swap the
    /// active backend at runtime.
    pub fn swappable(&self) -> &Arc<SwappableEmbedder> {
        &self.embedder
    }

    /// Owned snapshot of the active backend's model id. Use this
    /// everywhere a `String` is acceptable — `&str` borrows are unsafe
    /// across the swap boundary.
    pub fn model_id(&self) -> String {
        self.embedder.current_model_id()
    }

    /// Index a single entry by id: diffs its chunk map against whatever is
    /// already stored (see [`plan_chunk_diff`]), embeds only new/changed
    /// chunks, reuses stored vectors for unchanged ones, and prunes chunks
    /// that no longer exist. Returns `AiError::IoError` when the entry
    /// doesn't exist or DB I/O fails. Errors from the embedder itself are
    /// surfaced as-is (nothing is written on an embed failure — any chunks
    /// already reused/embedded earlier in the same call stay uncommitted
    /// since `write_chunk_diff` runs once at the end).
    pub fn index_one(&self, conn: &Connection, entry_id: &str) -> Result<(), AiError> {
        // Snapshot the active backend ONCE so every embed call in this pass
        // and the final upsert use the same model_id even if a swap lands
        // mid-call.
        let backend = self.embedder.snapshot();
        let model_id = backend.model_id().to_string();

        let plan = plan_chunk_diff(conn, entry_id, &model_id)?;
        let mut embedded = Vec::with_capacity(plan.to_embed.len());
        for target in &plan.to_embed {
            embedded.push(backend.embed(&target.text)?);
        }
        // Stamp last-used on the SwappableEmbedder so the lib.rs
        // eviction task can decide to swap the heavy ONNX session
        // out after the idle threshold (A3b-1b I4).
        self.embedder.touch();
        let now = chrono::Utc::now().timestamp();
        write_chunk_diff(conn, entry_id, &model_id, &plan, &embedded, now)
    }

    /// Process one row claimed from `entry_embedding_jobs`
    /// (`db::embeddings::claim_due_embedding_jobs`): diffs, embeds
    /// new/changed chunks only, writes the result, and transitions the job
    /// to its terminal status for this pass.
    ///
    /// - Canonical text below [`AI_ENTRY_EMBED_MIN_CHARS`] → `skip_embedding_job`,
    ///   zero provider calls.
    /// - Entry unchanged and active model unchanged since the job was
    ///   claimed → embed + `complete_embedding_job`.
    /// - Entry's canonical hash changed since the job was claimed (edited
    ///   again mid-embed, including DURING the embed call itself) or the
    ///   active embedding model changed mid-embed → discard the (now
    ///   stale) plan/embed results without writing them,
    ///   `reset_embedding_job_to_pending` so the next claim picks up the
    ///   latest content (Task 2/4's light guard, hardened in Task 5).
    /// - Embed call fails → exponential backoff (`error`) or, for an
    ///   auth/config-class error, `paused` with auto-retry stopped — see
    ///   [`finish_claimed_job`], which this delegates the post-embed policy
    ///   to (single source of truth, shared with the split lock/embed/lock
    ///   production path in `commands::ai::run_backfill_loop`).
    ///
    /// Holds `conn` for the whole call, including the embed itself — fine
    /// for tests / a single in-memory connection. Production wiring against
    /// `AppState`'s mutex-guarded connection uses [`claim_and_plan_batch`] +
    /// [`finish_claimed_job`] instead, splitting the embed call outside any
    /// lock (see module docs).
    pub fn index_claimed_job(
        &self,
        conn: &Connection,
        job: &embeddings::EmbeddingJobRow,
    ) -> Result<JobOutcome, AiError> {
        let now = chrono::Utc::now().timestamp();
        let entry_id = &job.entry_id;
        let model_id = &job.model_id;

        let plan = plan_chunk_diff(conn, entry_id, model_id)?;
        if plan.text_char_count < AI_ENTRY_EMBED_MIN_CHARS || plan.is_locked_excluded {
            skip_and_maybe_prune(conn, entry_id, model_id, &plan, now)?;
            return Ok(JobOutcome::Skipped {
                entry_id: entry_id.clone(),
            });
        }

        let backend = self.embedder.snapshot();
        let mut embedded = Vec::with_capacity(plan.to_embed.len());
        for target in &plan.to_embed {
            match backend.embed(&target.text) {
                Ok(v) => embedded.push(v),
                Err(e) => {
                    let claimed = ClaimedJobPlan {
                        job: job.clone(),
                        plan,
                    };
                    // Re-read the active model id fresh — the embedder is a
                    // hot-swappable `Arc` another thread could have swapped
                    // while this call held `conn` across the embed loop.
                    return finish_claimed_job(conn, &claimed, &self.model_id(), Err(e));
                }
            }
        }
        self.embedder.touch();

        let claimed = ClaimedJobPlan {
            job: job.clone(),
            plan,
        };
        finish_claimed_job(conn, &claimed, &self.model_id(), Ok(embedded))
    }

    /// Claim up to `limit` due jobs for the active model id and process
    /// each via [`Self::index_claimed_job`]. Convenience for tests and
    /// single-connection callers — see [`Self::index_claimed_job`] for the
    /// production-wiring caveat.
    pub fn process_due_jobs(
        &self,
        conn: &Connection,
        limit: usize,
    ) -> Result<Vec<JobOutcome>, AiError> {
        let model_id = self.model_id();
        let now = chrono::Utc::now().timestamp();
        let include_protected = read_include_protected(conn);
        let jobs =
            embeddings::claim_due_embedding_jobs(conn, &model_id, limit, now, include_protected)
                .map_err(|e| AiError::IoError(format!("claim_due_embedding_jobs: {e}")))?;
        jobs.iter()
            .map(|job| self.index_claimed_job(conn, job))
            .collect()
    }

    /// One pass of the always-on, app-open background worker (Phase 2 Task
    /// 3). Drains up to `dirty_limit` due jobs from `entry_embedding_jobs`
    /// first (entries edited since they were last indexed). When nothing is
    /// due, uses the idle time to opportunistically index up to
    /// `opportunistic_limit` eligible entries that have **never** been
    /// touched at all — no stored chunks AND no `entry_embedding_jobs` row
    /// — recency-first (`db::embeddings::list_entries_needing_index` is
    /// already ordered by the owning entry's `updated_at DESC`). A
    /// candidate that already has a job row (e.g. a brand-new,
    /// actively-edited entry the save-path hook just dirty-marked with a
    /// future `next_attempt_at`) is skipped by the opportunistic seed step
    /// — it keeps waiting its own quiet window rather than getting pulled
    /// forward to "now" just because it also has zero chunks yet.
    ///
    /// Opportunistic entries are seeded into the SAME dirty queue
    /// (`mark_entry_embedding_dirty` with an immediate `next_attempt_at`)
    /// and then claimed/processed through [`Self::index_claimed_job`] —
    /// there is still exactly one write path (`write_chunk_diff`) and one
    /// status machine (`entry_embedding_jobs`); this never becomes a rival
    /// "opportunistic" code path that bypasses the job bookkeeping.
    ///
    /// Gated by [`crate::commands::ai_settings::entry_embed_auto_allowed`]:
    /// when it returns `false` (hosted embedding slot without recorded
    /// consent, master toggle off, or embed-sync decision pending / Pause+all),
    /// this makes **zero** provider calls and zero writes — a job already
    /// sitting in the dirty queue from an earlier save must not be drained
    /// just because it got there before consent was revoked.
    ///
    /// Holds `conn` for the whole call, same production-wiring caveat as
    /// [`Self::index_claimed_job`] (see module docs) — the split
    /// lock/embed/lock production path is [`claim_and_plan_batch`] +
    /// [`finish_claimed_job`], used by `commands::ai::run_worker_tick_inner`
    /// instead of this convenience method.
    pub fn process_worker_batch(
        &self,
        conn: &Connection,
        dirty_limit: usize,
        opportunistic_limit: usize,
    ) -> Result<Vec<JobOutcome>, AiError> {
        if !crate::commands::ai_settings::entry_embed_auto_allowed(conn) {
            return Ok(Vec::new());
        }
        let model_id = self.model_id();
        let claimed = claim_batch_jobs(conn, &model_id, dirty_limit, opportunistic_limit)?;
        claimed
            .iter()
            .map(|job| self.index_claimed_job(conn, job))
            .collect()
    }

    /// Backfill every unindexed entry for the active model id. Throttles
    /// between entries, emits a [`BackfillProgress`] per entry, and exits
    /// immediately when `cancel` fires. Returns the number of entries
    /// successfully indexed (not counting cancellations).
    ///
    /// Errors during a single entry's index are logged-but-not-fatal: the
    /// loop moves on to the next entry.
    pub async fn backfill(
        &self,
        // We take a closure that lends a `&Connection` because `Connection`
        // is `!Send`. The closures themselves can still be `Send` (and
        // therefore safe to spawn on Tauri's multi-thread runtime) when
        // they capture only `Send` data and acquire the connection lock
        // *inside* the body — see `commands::ai::start_backfill` for the
        // canonical pattern that locks `AppState` per-call and drops the
        // guard before returning.
        with_conn: impl Fn(&dyn Fn(&Connection) -> Vec<String>) -> Vec<String>,
        progress_tx: mpsc::Sender<BackfillProgress>,
        cancel: CancellationToken,
        index_one_fn: impl Fn(&str) -> Result<(), AiError>,
    ) -> u64 {
        // Snapshot the model id once at the start so the whole run reports
        // a stable id even if a swap lands mid-backfill. Per-entry index
        // calls take their own snapshot inside `index_one` so the actual
        // upserted vectors stay correct under a swap.
        let model_id = self.model_id();
        let pending: Vec<String> = with_conn(&|conn: &Connection| {
            // Caller resolves the setting so this DB call stays pure — same
            // convention as `LockedView`/`reveal_invisible` elsewhere.
            let include_protected = read_include_protected(conn);
            embeddings::list_entries_needing_index(
                conn,
                &model_id,
                i64::MAX as usize,
                include_protected,
            )
            .unwrap_or_default()
        });
        let total = pending.len() as u64;
        let mut indexed: u64 = 0;

        for entry_id in pending {
            if cancel.is_cancelled() {
                break;
            }
            match index_one_fn(&entry_id) {
                Ok(()) => indexed += 1,
                Err(e) => {
                    log::warn!("backfill: index_one('{entry_id}') failed: {e:?}");
                }
            }
            let _ = progress_tx
                .send(BackfillProgress {
                    model_id: model_id.clone(),
                    indexed,
                    total,
                    current_entry_id: entry_id,
                })
                .await;

            // Cooperative throttle. Watching the cancel token via select!
            // means a cancel during the sleep is observed within ms, not
            // 2s. The branches return `()` so they unify cleanly.
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(self.throttle) => {}
            }
        }
        indexed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::embedder::StubEmbedder;
    use crate::db::schema;
    use rusqlite::params;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        schema::migrate(&conn).expect("migrate");
        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at) VALUES ('j1', 'J', 0, 0)",
            [],
        )
        .expect("seed journal");
        conn
    }

    fn insert_entry(conn: &Connection, id: &str, title: &str, content: &str) {
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date,
                                  created_at, updated_at)
             VALUES (?1, 'j1', ?2, ?3, 0, 0, 0)",
            params![id, title, content],
        )
        .expect("insert entry");
    }

    #[test]
    fn build_indexable_text_combines_title_and_content() {
        assert_eq!(
            build_indexable_text(Some("Hello"), Some("World")),
            "Hello\n\nWorld"
        );
        assert_eq!(build_indexable_text(Some("Hello"), None), "Hello");
        assert_eq!(
            build_indexable_text(None, Some("only content")),
            "only content"
        );
        assert_eq!(build_indexable_text(None, None), "");
        // whitespace-only fields are treated as empty.
        assert_eq!(build_indexable_text(Some("   "), Some("body")), "body");
    }

    #[test]
    fn index_one_writes_row_for_active_model() {
        let conn = open_test_db();
        // "Title\n\nBody text" chunks into two blocks (title, body).
        insert_entry(&conn, "e1", "Title", "Body text");

        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::default_for_dev()));
        indexer.index_one(&conn, "e1").expect("index");

        let chunks =
            embeddings::list_stored_chunks(&conn, "e1", "embedding-stub-768").expect("list chunks");
        assert_eq!(chunks.len(), 2, "index_one diffs into real chunk map");
        for c in &chunks {
            assert_eq!(c.dim, 768);
            assert_eq!(c.vec.len(), 768);
        }
    }

    #[test]
    fn index_one_is_idempotent() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "Title", "Body");
        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        indexer.index_one(&conn, "e1").unwrap();
        let first = embeddings::list_stored_chunks(&conn, "e1", &indexer.model_id()).unwrap();
        indexer.index_one(&conn, "e1").unwrap();
        let second = embeddings::list_stored_chunks(&conn, "e1", &indexer.model_id()).unwrap();

        assert_eq!(
            second.len(),
            first.len(),
            "second index must overwrite, not duplicate"
        );
        let first_vecs: Vec<&Vec<f32>> = first.iter().map(|c| &c.vec).collect();
        let second_vecs: Vec<&Vec<f32>> = second.iter().map(|c| &c.vec).collect();
        assert_eq!(
            second_vecs, first_vecs,
            "unchanged content reuses the same stored vectors, not a re-embed"
        );
    }

    /// Hot-swap: index one entry under "stub-A", swap to a different model
    /// id, index a second entry. Both rows must be present, each tagged
    /// with the model_id active when the upsert ran.
    #[test]
    fn index_one_uses_active_model_after_swap() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "T1", "C1");
        insert_entry(&conn, "e2", "T2", "C2");

        let indexer = EntryIndexer::from_dyn(Arc::new(StubEmbedder::new("stub-a", 384)))
            .with_throttle(Duration::ZERO);
        indexer.index_one(&conn, "e1").expect("index e1");
        assert_eq!(indexer.model_id(), "stub-a");

        // Swap to a fresh stub with a different id + dim.
        indexer
            .swappable()
            .swap(Arc::new(StubEmbedder::new("stub-b", 768)));
        assert_eq!(indexer.model_id(), "stub-b");

        indexer.index_one(&conn, "e2").expect("index e2");

        let chunks_a = embeddings::list_stored_chunks(&conn, "e1", "stub-a").expect("get a");
        let chunks_b = embeddings::list_stored_chunks(&conn, "e2", "stub-b").expect("get b");
        // "T1\n\nC1" / "T2\n\nC2" each chunk into two blocks (title, body).
        assert_eq!(chunks_a.len(), 2, "pre-swap entry has chunks under stub-a");
        assert_eq!(chunks_b.len(), 2, "post-swap entry has chunks under stub-b");
        assert_eq!(chunks_a[0].dim, 384, "pre-swap entry kept its dim");
        assert_eq!(chunks_b[0].dim, 768, "post-swap entry uses new dim");

        // Cross-model rows do NOT leak: e1 has no row under stub-b.
        let cross = embeddings::list_stored_chunks(&conn, "e1", "stub-b").expect("get cross");
        assert!(
            cross.is_empty(),
            "swapping does not migrate prior model's rows"
        );
    }

    #[test]
    fn index_one_returns_error_for_missing_entry() {
        let conn = open_test_db();
        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let result = indexer.index_one(&conn, "does-not-exist");
        assert!(matches!(result, Err(AiError::IoError(_))));
    }

    /// Backfill happy path: 3 unindexed entries → 3 rows in the table +
    /// 3 progress events.
    #[tokio::test(flavor = "current_thread")]
    async fn backfill_indexes_all_pending_entries() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "T1", "C1");
        insert_entry(&conn, "e2", "T2", "C2");
        insert_entry(&conn, "e3", "T3", "C3");

        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let model_id = indexer.model_id();

        let (tx, mut rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();

        // The closures borrow `conn`; backfill is single-threaded with tokio
        // current_thread runtime so that's fine.
        let with_conn = |f: &dyn Fn(&Connection) -> Vec<String>| f(&conn);
        let index_one = |id: &str| indexer.index_one(&conn, id);

        let count = indexer.backfill(with_conn, tx, cancel, index_one).await;
        assert_eq!(count, 3);

        let mut events = Vec::new();
        while let Ok(p) = rx.try_recv() {
            events.push(p);
        }
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].total, 3);
        assert_eq!(events[2].indexed, 3);

        let n = embeddings::count_indexed_entries_for_model(&conn, &model_id, false).unwrap();
        assert_eq!(n, 3);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backfill_skips_already_indexed_entries() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "T1", "C1");
        insert_entry(&conn, "e2", "T2", "C2");
        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        // Pre-index e1.
        indexer.index_one(&conn, "e1").unwrap();

        let (tx, _rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let with_conn = |f: &dyn Fn(&Connection) -> Vec<String>| f(&conn);
        let index_one = |id: &str| indexer.index_one(&conn, id);

        let count = indexer.backfill(with_conn, tx, cancel, index_one).await;
        assert_eq!(count, 1, "only e2 should be processed");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backfill_stops_when_cancelled() {
        let conn = open_test_db();
        for i in 0..5 {
            insert_entry(&conn, &format!("e{i}"), "T", "C");
        }
        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let (tx, _rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        cancel.cancel(); // pre-cancel — first iteration's check exits immediately.

        let with_conn = |f: &dyn Fn(&Connection) -> Vec<String>| f(&conn);
        let index_one = |id: &str| indexer.index_one(&conn, id);

        let count = indexer.backfill(with_conn, tx, cancel, index_one).await;
        assert_eq!(count, 0, "pre-cancelled backfill must index nothing");
    }

    /// Task 6 write-side gate, exercised through the real `backfill` entry
    /// point: with `ai_embed_include_protected` unset (default false), a
    /// locked entry must never reach `list_entries_needing_index`'s pending
    /// list, so `backfill` never embeds it.
    #[tokio::test(flavor = "current_thread")]
    async fn backfill_excludes_locked_entry_by_default() {
        let conn = open_test_db();
        insert_entry(&conn, "visible", "T1", "C1");
        insert_entry(&conn, "locked", "T2", "C2");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();

        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let (tx, _rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let with_conn = |f: &dyn Fn(&Connection) -> Vec<String>| f(&conn);
        let index_one = |id: &str| indexer.index_one(&conn, id);

        let count = indexer.backfill(with_conn, tx, cancel, index_one).await;
        assert_eq!(count, 1, "only the visible entry is write-eligible");
        assert!(
            embeddings::list_stored_chunks(&conn, "locked", &indexer.model_id())
                .unwrap()
                .is_empty(),
            "locked entry must never be embedded when include_protected is off"
        );
    }

    /// Same setup, but `ai_embed_include_protected` is ON: the locked entry
    /// becomes write-eligible and gets embedded by backfill.
    #[tokio::test(flavor = "current_thread")]
    async fn backfill_includes_locked_entry_when_include_protected() {
        let conn = open_test_db();
        insert_entry(&conn, "visible", "T1", "C1");
        insert_entry(&conn, "locked", "T2", "C2");
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'locked'", [])
            .unwrap();
        crate::db::queries::set_setting(
            &conn,
            crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
            "true",
        )
        .unwrap();

        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let (tx, _rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let with_conn = |f: &dyn Fn(&Connection) -> Vec<String>| f(&conn);
        let index_one = |id: &str| indexer.index_one(&conn, id);

        let count = indexer.backfill(with_conn, tx, cancel, index_one).await;
        assert_eq!(
            count, 2,
            "both entries are write-eligible when include_protected is on"
        );
        assert!(
            !embeddings::list_stored_chunks(&conn, "locked", &indexer.model_id())
                .unwrap()
                .is_empty(),
            "locked entry must be embedded when include_protected is on"
        );
    }

    // ── Phase 2 Task 2: chunk-diff worker ──────────────────────────────
    //
    // `cargo test embedding_worker` selects every test in this section.

    use std::sync::atomic::{AtomicU64, Ordering};

    /// Counts every `embed` call so tests can assert the core token-saving
    /// guarantee directly: "N chunks genuinely changed → exactly N
    /// provider calls," regardless of how many chunks were reused.
    struct CountingEmbedder {
        inner: StubEmbedder,
        calls: AtomicU64,
    }

    impl CountingEmbedder {
        fn new(model_id: &str, dim: usize) -> Self {
            Self {
                inner: StubEmbedder::new(model_id, dim),
                calls: AtomicU64::new(0),
            }
        }

        fn call_count(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl crate::ai::embedder::Embedder for CountingEmbedder {
        fn model_id(&self) -> &str {
            self.inner.model_id()
        }
        fn dim(&self) -> usize {
            self.inner.dim()
        }
        fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.inner.embed(text)
        }
    }

    /// Queue a dirty job the way `commands::entries::maybe_mark_entry_embedding_dirty_after_save`
    /// does: read the entry's live canonical text, hash it, upsert the job
    /// row with `next_attempt_at = 0` so it's immediately due.
    fn queue_dirty_job(conn: &Connection, model_id: &str, entry_id: &str) {
        let entry = crate::db::queries::get_entry_for_provider(conn, entry_id)
            .unwrap()
            .unwrap();
        let text = build_indexable_text(entry.title.as_deref(), entry.content_text.as_deref());
        let hash = crate::ai::chunking::content_hash(&text);
        embeddings::mark_entry_embedding_dirty(conn, entry_id, model_id, &hash, 0, 0).unwrap();
    }

    fn update_entry_content(conn: &Connection, id: &str, content: &str) {
        conn.execute(
            "UPDATE entries SET content_text = ?2 WHERE id = ?1",
            params![id, content],
        )
        .expect("update entry content");
    }

    /// Plan-level guardrail (mechanism-independent): editing exactly one
    /// paragraph of an already-indexed multi-chunk entry must diff into
    /// exactly one `to_embed` target, with the other chunks reused.
    #[test]
    fn embedding_worker_plan_diffs_only_the_edited_paragraph() {
        let conn = open_test_db();
        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let content =
            "Paragraph one text.\n\nParagraph two original text.\n\nParagraph three text.";
        insert_entry(&conn, "e1", "", content);
        indexer.index_one(&conn, "e1").unwrap();
        let model_id = indexer.model_id();
        assert_eq!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .len(),
            3
        );

        let edited =
            "Paragraph one text.\n\nParagraph two EDITED text now.\n\nParagraph three text.";
        update_entry_content(&conn, "e1", edited);

        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(
            plan.to_embed.len(),
            1,
            "only the edited paragraph needs a fresh embed"
        );
        assert_eq!(
            plan.to_reuse.len(),
            2,
            "the other two paragraphs reuse their stored vectors"
        );
    }

    /// The core guardrail: a mid-entry paragraph INSERT shifts every later
    /// chunk_index, but their content_hash is unchanged — only the
    /// inserted chunk should be flagged for embedding.
    #[test]
    fn embedding_worker_plan_diffs_only_inserted_paragraph_despite_index_shift() {
        let conn = open_test_db();
        let indexer = EntryIndexer::with_stub().with_throttle(Duration::ZERO);
        let content = "Intro paragraph text.\n\nBody paragraph text.";
        insert_entry(&conn, "e1", "", content);
        indexer.index_one(&conn, "e1").unwrap();
        let model_id = indexer.model_id();
        let before = embeddings::list_stored_chunks(&conn, "e1", &model_id).unwrap();
        assert_eq!(before.len(), 2);
        let before_vecs: std::collections::HashMap<String, Vec<f32>> = before
            .iter()
            .map(|c| (c.content_hash.clone(), c.vec.clone()))
            .collect();

        // Insert a new paragraph at the top — shifts both existing
        // paragraphs' chunk_index by one; their content is untouched.
        let inserted = "Preface paragraph text.\n\nIntro paragraph text.\n\nBody paragraph text.";
        update_entry_content(&conn, "e1", inserted);

        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(
            plan.to_embed.len(),
            1,
            "only the newly inserted paragraph is embedded"
        );
        assert_eq!(
            plan.to_reuse.len(),
            2,
            "intro/body reuse their stored vectors despite the index shift"
        );
        assert_eq!(
            plan.to_embed[0].chunk_index, 0,
            "new paragraph lands at index 0"
        );
        for reused in &plan.to_reuse {
            let expected = before_vecs
                .get(&reused.content_hash)
                .expect("hash carried over from the pre-insert stored set");
            assert_eq!(
                &reused.vec, expected,
                "reused chunk keeps its original vector, not a re-embed"
            );
        }
    }

    /// End-to-end via the claimed-job pipeline (provider-call-counting):
    /// one-paragraph edit of a multi-chunk entry embeds exactly the
    /// changed chunk; the other two cost zero provider calls.
    #[test]
    fn embedding_worker_edit_embeds_only_changed_chunk_via_claimed_job() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        let content =
            "Paragraph one text.\n\nParagraph two original text.\n\nParagraph three text.";
        insert_entry(&conn, "e1", "", content);
        indexer.index_one(&conn, "e1").unwrap();
        assert_eq!(
            embedder.call_count(),
            3,
            "initial index embeds all 3 chunks"
        );

        let edited =
            "Paragraph one text.\n\nParagraph two EDITED text now.\n\nParagraph three text.";
        update_entry_content(&conn, "e1", edited);
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        match &outcome {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 1, "only the edited chunk was embedded");
                assert_eq!(*reused, 2, "the other two chunks were reused");
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert_eq!(
            embedder.call_count(),
            4,
            "3 initial + 1 for the edited paragraph — the untouched two are never re-embedded"
        );
        assert_eq!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .len(),
            3
        );
    }

    /// Build an [`embeddings::IncomingChunkVector`] fixture for
    /// `adopt_synced_chunk_vector` from a `ChunkEmbedTarget` planned by
    /// [`plan_chunk_diff`] — the `content_hash` is copied verbatim so the
    /// adoption's hash-match gate passes (simulates a peer device that
    /// embedded the exact same content this device would).
    fn incoming_for_target(
        entry_id: &str,
        model_id: &str,
        target: &ChunkEmbedTarget,
        vec: &[f32],
    ) -> embeddings::IncomingChunkVector {
        embeddings::IncomingChunkVector {
            entry_id: entry_id.to_string(),
            model_id: model_id.to_string(),
            chunk_index: target.chunk_index,
            content_hash: target.content_hash.clone(),
            dim: vec.len() as i64,
            vec: embeddings::vec_to_blob(vec),
        }
    }

    /// Phase 5 Task 4 (integration): a pull that adopts vectors for EVERY
    /// chunk of an entry's dirty job must resolve that job to `indexed`
    /// with ZERO embedding provider calls — `plan_chunk_diff`'s hash-diff
    /// naturally classifies every adopted chunk as `to_reuse` since its
    /// `content_hash` already matches what's stored.
    #[test]
    fn embedding_worker_all_chunks_adopted_completes_job_with_zero_calls() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        let content = "Paragraph one text.\n\nParagraph two text.\n\nParagraph three text.";
        insert_entry(&conn, "e1", "", content);
        let model_id = indexer.model_id();

        // Simulate a pull landing before this device ever embedded the
        // entry locally: adopt a vector for every chunk the current
        // content would produce.
        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(plan.to_embed.len(), 3, "fixture chunks into 3 paragraphs");
        for target in &plan.to_embed {
            let incoming = incoming_for_target("e1", &model_id, target, &[0.1, 0.2, 0.3, 0.4]);
            let outcome =
                embeddings::adopt_synced_chunk_vector(&conn, true, &incoming, false, 50).unwrap();
            assert_eq!(outcome, embeddings::AdoptOutcome::Adopted);
        }

        // The device-local dirty queue still has a pending job for this
        // entry (e.g. queued right before the pull landed) — the worker
        // must discover the hash-diff is already fully satisfied and
        // complete it without a single provider call.
        queue_dirty_job(&conn, &model_id, "e1");
        let outcomes = indexer.process_due_jobs(&conn, 10).unwrap();
        assert_eq!(outcomes.len(), 1);
        match &outcomes[0] {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 0, "every chunk was adopted, none embedded");
                assert_eq!(*reused, 3);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert_eq!(embedder.call_count(), 0, "zero provider calls");

        let job = embeddings::get_embedding_job(&conn, "e1", &model_id)
            .unwrap()
            .expect("job row still exists");
        assert_eq!(job.status, "indexed");
    }

    /// Phase 5 Task 4 (partial adoption): when only SOME of an entry's
    /// chunks arrive via sync adoption, the worker must embed exactly the
    /// remaining un-adopted chunks — never re-embed the adopted ones.
    #[test]
    fn embedding_worker_partial_adoption_embeds_only_unadopted_chunks() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        let content = "Paragraph one text.\n\nParagraph two text.\n\nParagraph three text.";
        insert_entry(&conn, "e1", "", content);
        let model_id = indexer.model_id();

        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(plan.to_embed.len(), 3);
        // Adopt only the first two chunks; the third is left for the
        // worker to embed locally.
        for target in plan.to_embed.iter().take(2) {
            let incoming = incoming_for_target("e1", &model_id, target, &[0.1, 0.2, 0.3, 0.4]);
            let outcome =
                embeddings::adopt_synced_chunk_vector(&conn, true, &incoming, false, 50).unwrap();
            assert_eq!(outcome, embeddings::AdoptOutcome::Adopted);
        }

        queue_dirty_job(&conn, &model_id, "e1");
        let outcomes = indexer.process_due_jobs(&conn, 10).unwrap();
        assert_eq!(outcomes.len(), 1);
        match &outcomes[0] {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 1, "only the un-adopted chunk is embedded");
                assert_eq!(
                    *reused, 2,
                    "the two adopted chunks are reused, not re-embedded"
                );
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert_eq!(embedder.call_count(), 1, "exactly one provider call");
    }

    /// Phase 5 Task 4 (double-write guard): adopting a chunk vector, then
    /// running the local worker's diff/write over the SAME (unchanged)
    /// content must reuse the adopted vector verbatim — never re-embed it —
    /// and `upsert_chunk`'s `(entry_id, model_id, chunk_index)` PK must stay
    /// unique (no duplicate/conflicting row from the two write paths).
    #[test]
    fn embedding_worker_adopted_chunk_survives_local_diff_without_double_write() {
        let conn = open_test_db();
        let model_id = "count-stub".to_string();
        insert_entry(&conn, "e1", "", "Solo paragraph text.");

        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(plan.to_embed.len(), 1);
        let target = &plan.to_embed[0];
        let adopted_vec = vec![0.9_f32, 0.8, 0.7, 0.6];
        let incoming = incoming_for_target("e1", &model_id, target, &adopted_vec);
        assert_eq!(
            embeddings::adopt_synced_chunk_vector(&conn, true, &incoming, false, 50).unwrap(),
            embeddings::AdoptOutcome::Adopted
        );

        // Re-plan over the identical content: the adopted chunk's
        // content_hash already matches, so it must land in `to_reuse`,
        // never `to_embed`.
        let plan2 = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(
            plan2.to_embed.len(),
            0,
            "adopted chunk must not be queued for re-embedding"
        );
        assert_eq!(plan2.to_reuse.len(), 1);
        assert_eq!(
            plan2.to_reuse[0].vec, adopted_vec,
            "reuses the adopted vector verbatim"
        );

        write_chunk_diff(&conn, "e1", &model_id, &plan2, &[], 100).unwrap();

        let stored = embeddings::list_stored_chunks(&conn, "e1", &model_id).unwrap();
        assert_eq!(
            stored.len(),
            1,
            "no duplicate/conflicting row for the same (entry_id, model_id, chunk_index)"
        );
        assert_eq!(
            stored[0].vec, adopted_vec,
            "adopted vector preserved, not clobbered by a local re-embed"
        );
    }

    /// End-to-end via the claimed-job pipeline: a mid-entry paragraph
    /// INSERT shifts later chunk_index values but only the inserted
    /// paragraph is embedded — the shifted chunks are reused by hash.
    #[test]
    fn embedding_worker_paragraph_insert_reuses_shifted_chunks_via_claimed_job() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        let content = "Intro paragraph text.\n\nBody paragraph text.";
        insert_entry(&conn, "e1", "", content);
        indexer.index_one(&conn, "e1").unwrap();
        assert_eq!(embedder.call_count(), 2);

        let inserted = "Preface paragraph text.\n\nIntro paragraph text.\n\nBody paragraph text.";
        update_entry_content(&conn, "e1", inserted);
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        match &outcome {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(
                    *embedded, 1,
                    "only the newly inserted paragraph is embedded"
                );
                assert_eq!(
                    *reused, 2,
                    "intro/body reuse despite their chunk_index shifting"
                );
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert_eq!(
            embedder.call_count(),
            3,
            "2 initial + 1 for the inserted paragraph only"
        );
    }

    /// Removing a paragraph entirely must prune its chunk row at zero
    /// provider cost — no embed call is needed to delete something.
    #[test]
    fn embedding_worker_removed_paragraph_is_pruned_with_zero_calls() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        let content = "Paragraph one text.\n\nParagraph two text.\n\nParagraph three text.";
        insert_entry(&conn, "e1", "", content);
        indexer.index_one(&conn, "e1").unwrap();
        assert_eq!(embedder.call_count(), 3);
        let model_id = indexer.model_id();
        assert_eq!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .len(),
            3
        );

        // Remove paragraph two entirely.
        let shortened = "Paragraph one text.\n\nParagraph three text.";
        update_entry_content(&conn, "e1", shortened);
        queue_dirty_job(&conn, &model_id, "e1");

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        match &outcome {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 0, "paragraphs one/three are unchanged");
                assert_eq!(*reused, 2);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert_eq!(
            embedder.call_count(),
            3,
            "no new provider calls are needed to remove a chunk"
        );
        assert_eq!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .len(),
            2,
            "removed paragraph's chunk row is pruned"
        );
    }

    /// A too-short entry must be skipped, not embedded — zero provider
    /// calls, job status flips to `skipped`. The worker re-checks this
    /// independently of the save-path hook's own gate (e.g. an edit could
    /// shorten the entry after the job was already queued).
    #[test]
    fn embedding_worker_too_short_entry_is_skipped_with_zero_calls() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(&conn, "e1", "", "hi"); // well under AI_ENTRY_EMBED_MIN_CHARS
        let model_id = indexer.model_id();
        embeddings::mark_entry_embedding_dirty(&conn, "e1", &model_id, "irrelevant-hash", 0, 0)
            .unwrap();

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e1".to_string()
            }
        );
        assert_eq!(
            embedder.call_count(),
            0,
            "too-short entry never reaches the provider"
        );

        let status: String = conn
            .query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id=?1",
                params![model_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "skipped");
    }

    /// Empty entry (no title, no content) — same skip path, zero calls.
    #[test]
    fn embedding_worker_empty_entry_is_skipped_with_zero_calls() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(&conn, "e1", "", "");
        let model_id = indexer.model_id();
        embeddings::mark_entry_embedding_dirty(&conn, "e1", &model_id, "irrelevant-hash", 0, 0)
            .unwrap();

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e1".to_string()
            }
        );
        assert_eq!(embedder.call_count(), 0);
    }

    /// Race guard (Task 2/4's light version — see the Task 5 section below
    /// for the hardened version covering an edit landing DURING the embed
    /// call itself): if the entry's canonical hash changes between the job
    /// snapshot and the write, the stale results must be discarded and the
    /// job reset to `pending` rather than marked `indexed` with content the
    /// job never actually
    /// embedded fully.
    #[test]
    fn embedding_worker_hash_mismatch_at_write_time_resets_job_to_pending() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Original paragraph text long enough to embed.",
        );
        indexer.index_one(&conn, "e1").unwrap();
        let model_id = indexer.model_id();
        // Snapshot the chunk store BEFORE the race — the "no stale chunk"
        // assertion below (Task 7: "edit while in_progress resets to
        // pending with no stale chunk") compares against this exact set.
        let chunks_before_race = embeddings::list_stored_chunks(&conn, "e1", &model_id).unwrap();
        assert_eq!(chunks_before_race.len(), 1);

        // Queue a job snapshotting the ORIGINAL content...
        queue_dirty_job(&conn, &model_id, "e1");
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        let stale_job = jobs[0].clone();
        assert_eq!(
            stale_job.status, "in_progress",
            "claim flips status to in_progress"
        );

        // ...then the entry changes again before the (stale) job is
        // processed — simulates an edit landing while the worker was
        // mid-embed for the earlier snapshot.
        update_entry_content(&conn, "e1", "Completely different paragraph text now.");

        let outcome = indexer.index_claimed_job(&conn, &stale_job).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Retried {
                entry_id: "e1".to_string()
            }
        );

        let status: String = conn
            .query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id=?1",
                params![model_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "pending",
            "stale job must be reset to pending, never left completed with wrong content"
        );
        let chunks_after_race = embeddings::list_stored_chunks(&conn, "e1", &model_id).unwrap();
        assert_eq!(
            chunks_after_race, chunks_before_race,
            "no stale chunk from the abandoned in_progress attempt may be written — \
             the stored chunk from before the race must be byte-for-byte unchanged"
        );
    }

    // ── Phase 2 Task 5: hardened provider/model + content-hash guards ──
    //
    // `cargo test embedding_worker` also selects these. These exercise
    // [`finish_claimed_job`] directly (rather than through the async split
    // lock/embed/lock production path) because the race windows they cover
    // — a provider/model swap, or an edit landing DURING the embed call —
    // open up strictly BETWEEN [`plan_chunk_diff`] (lock-held) and
    // [`finish_claimed_job`] (fresh lock), which is exactly the boundary a
    // synchronous unit test can straddle directly.

    /// The active embedding model changes mid-embed (a provider/model swap
    /// lands between planning and the write-back). The stale-model vectors
    /// must never be persisted under the OLD model_id and the old job must
    /// never be marked `indexed` — see [`JobOutcome::ModelChanged`].
    #[test]
    fn embedding_worker_model_change_mid_job_discards_stale_results() {
        let conn = open_test_db();
        let indexer = EntryIndexer::from_dyn(Arc::new(CountingEmbedder::new("model-a", 8)))
            .with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed for this model-swap test.",
        );
        let model_a = indexer.model_id();
        queue_dirty_job(&conn, &model_a, "e1");
        let jobs = embeddings::claim_due_embedding_jobs(&conn, &model_a, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);

        // Plan + "embed" against model-a (the model_id active when the job
        // was claimed/planned).
        let plan = plan_chunk_diff(&conn, "e1", &model_a).unwrap();
        assert!(
            !plan.to_embed.is_empty(),
            "fixture must have a chunk to embed"
        );
        let embedded: Vec<Vec<f32>> = plan.to_embed.iter().map(|_| vec![0.1; 8]).collect();
        let claimed = ClaimedJobPlan {
            job: jobs[0].clone(),
            plan,
        };

        // By write time the active model has moved on to model-b — the
        // caller re-reads the active model id fresh after the embed call
        // returns (see `commands::ai::run_worker_tick_inner`).
        let outcome = finish_claimed_job(&conn, &claimed, "model-b", Ok(embedded)).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::ModelChanged {
                entry_id: "e1".to_string()
            }
        );

        assert!(
            embeddings::list_stored_chunks(&conn, "e1", &model_a)
                .unwrap()
                .is_empty(),
            "stale model-a chunks must never be written"
        );
        assert!(
            embeddings::list_stored_chunks(&conn, "e1", "model-b")
                .unwrap()
                .is_empty(),
            "nothing is written under model-b either — that's Task 6's enqueue, not this write"
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id=?1",
                params![model_a],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "pending",
            "the old model-a job resets to pending rather than being left `in_progress` \
             forever or wrongly marked `indexed`"
        );
    }

    fn discard_as_model_changed(conn: &Connection, claimed: &ClaimedJobPlan, new_model_id: &str) {
        let embedded: Vec<Vec<f32>> = claimed.plan.to_embed.iter().map(|_| vec![0.1; 8]).collect();
        let outcome = finish_claimed_job(conn, claimed, new_model_id, Ok(embedded)).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::ModelChanged {
                entry_id: claimed.job.entry_id.clone()
            }
        );
    }

    fn plan_claimed(conn: &Connection, job: embeddings::EmbeddingJobRow) -> ClaimedJobPlan {
        let plan = plan_chunk_diff(conn, &job.entry_id, &job.model_id).unwrap();
        assert!(
            !plan.to_embed.is_empty(),
            "fixture must have a chunk to embed"
        );
        ClaimedJobPlan { job, plan }
    }

    fn assert_pending_under(conn: &Connection, entry_id: &str, model_id: &str) {
        let job = embeddings::get_embedding_job(conn, entry_id, model_id)
            .unwrap()
            .unwrap_or_else(|| panic!("expected job for {entry_id} under {model_id}"));
        assert_eq!(
            job.status, "pending",
            "{entry_id} under {model_id} must be pending after provider-change enqueue"
        );
    }

    /// Single-job `ModelChanged` discard, then Task 6's provider-change
    /// enqueue: the entry must land as `pending` under the NEW model_id
    /// (the discard itself only resets the OLD-model row).
    #[test]
    fn embedding_worker_model_changed_discard_single_reenqueues_under_new_model() {
        let conn = open_test_db();
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed for this model-swap test.",
        );
        let old_model = "model-a";
        let new_model = "model-b";
        queue_dirty_job(&conn, old_model, "e1");
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, old_model, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        discard_as_model_changed(&conn, &plan_claimed(&conn, jobs[0].clone()), new_model);

        let enqueued = enqueue_dirty_jobs_for_model(&conn, new_model).unwrap();
        assert_eq!(
            enqueued, 1,
            "discarded single entry must be re-queued under the new model"
        );
        assert_pending_under(&conn, "e1", new_model);
    }

    /// Mid-batch `ModelChanged` discard (production `claim_and_plan_batch`
    /// + finish each job after the active model has moved on): every
    /// discarded entry must be re-queued under the NEW model_id.
    #[test]
    fn embedding_worker_model_changed_discard_mid_batch_reenqueues_under_new_model() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        insert_entry(&conn, "e1", "", "First entry text long enough to embed.");
        insert_entry(&conn, "e2", "", "Second entry text long enough to embed.");
        let old_model = "model-a";
        let new_model = "model-b";
        queue_dirty_job(&conn, old_model, "e1");
        queue_dirty_job(&conn, old_model, "e2");

        let claimed = claim_and_plan_batch(&conn, old_model, 10, 0).unwrap();
        assert_eq!(claimed.len(), 2, "both entries claimed in one batch");
        for c in &claimed {
            discard_as_model_changed(&conn, c, new_model);
        }

        let enqueued = enqueue_dirty_jobs_for_model(&conn, new_model).unwrap();
        assert_eq!(
            enqueued, 2,
            "both mid-batch discards must be re-queued under the new model"
        );
        assert_pending_under(&conn, "e1", new_model);
        assert_pending_under(&conn, "e2", new_model);
    }

    /// Entry already indexed under the OLD model, then re-claimed and
    /// discarded via `ModelChanged`: provider-change enqueue must still
    /// create a NEW-model job (old chunks must not hide it from the
    /// new-model anti-join).
    #[test]
    fn embedding_worker_model_changed_discard_already_indexed_under_old_reenqueues_under_new_model()
    {
        let conn = open_test_db();
        let indexer =
            EntryIndexer::from_dyn(Arc::new(StubEmbedder::new("model-a", 8)) as DynEmbedder)
                .with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Already indexed entry text long enough to embed.",
        );
        let old_model = indexer.model_id();
        let new_model = "model-b";
        queue_dirty_job(&conn, &old_model, "e1");
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &old_model, 10, 1_000, false).unwrap();
        indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            embeddings::get_embedding_job(&conn, "e1", &old_model)
                .unwrap()
                .unwrap()
                .status,
            "indexed"
        );
        assert!(
            !embeddings::list_stored_chunks(&conn, "e1", &old_model)
                .unwrap()
                .is_empty(),
            "sanity: entry starts indexed under the old model"
        );

        conn.execute(
            "UPDATE entries SET content_text = 'Edited already-indexed entry text, still long enough.', \
             updated_at = 9999999999 WHERE id = 'e1'",
            [],
        )
        .unwrap();
        queue_dirty_job(&conn, &old_model, "e1");
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &old_model, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        discard_as_model_changed(&conn, &plan_claimed(&conn, jobs[0].clone()), new_model);

        let enqueued = enqueue_dirty_jobs_for_model(&conn, new_model).unwrap();
        assert_eq!(
            enqueued, 1,
            "already-indexed-under-old must still be queued under the new model"
        );
        assert_pending_under(&conn, "e1", new_model);
        assert!(
            embeddings::list_stored_chunks(&conn, "e1", new_model)
                .unwrap()
                .is_empty(),
            "discard must not write chunks under the new model"
        );
    }

    /// An edit lands DURING the embed call itself — strictly AFTER
    /// `plan_chunk_diff` ran (so the light Task 2/4 guard, which only
    /// compares two before-the-embed snapshots, cannot see it) but BEFORE
    /// `finish_claimed_job` writes. The hardened guard re-reads the entry's
    /// CURRENT hash at write time and must discard the stale-content
    /// results, resetting the job to `pending` with the LATEST hash.
    #[test]
    fn embedding_worker_content_edited_during_embed_call_resets_to_pending_with_latest_hash() {
        let conn = open_test_db();
        let indexer = EntryIndexer::from_dyn(Arc::new(CountingEmbedder::new("model-a", 8)))
            .with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Original text long enough to embed for this write-time race test.",
        );
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);

        // Plan under a (simulated) short lock — mirrors `claim_and_plan_batch`.
        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert_eq!(
            jobs[0].content_hash, plan.whole_entry_hash,
            "queue-time and plan-time hashes agree before the race"
        );
        let embedded: Vec<Vec<f32>> = plan.to_embed.iter().map(|_| vec![0.2; 8]).collect();
        let claimed = ClaimedJobPlan {
            job: jobs[0].clone(),
            plan,
        };

        // The edit lands here — AFTER planning, DURING the (simulated)
        // async embed call outside any lock.
        update_entry_content(
            &conn,
            "e1",
            "Totally different text landed mid-embed, also long enough.",
        );

        let outcome = finish_claimed_job(&conn, &claimed, &model_id, Ok(embedded)).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Retried {
                entry_id: "e1".to_string()
            }
        );

        assert!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .is_empty(),
            "no chunk embedded against the pre-edit text may be persisted"
        );

        let (status, content_hash): (String, String) = conn
            .query_row(
                "SELECT status, content_hash FROM entry_embedding_jobs \
                 WHERE entry_id='e1' AND model_id=?1",
                params![model_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        // Re-planning now (content hasn't changed further) yields the same
        // hash the reset must have stamped — reuses production code rather
        // than re-deriving the hash formula in the test.
        let latest_hash = plan_chunk_diff(&conn, "e1", &model_id)
            .unwrap()
            .whole_entry_hash;
        assert_eq!(
            content_hash, latest_hash,
            "job row is stamped with the LATEST hash, not the stale plan-time one"
        );
    }

    /// A job left `in_progress` (simulating a cancel — embedding provider
    /// swap, `pause_backfill`, app lock — or a crash mid-embed) is
    /// recovered to `pending` at worker start
    /// ([`embeddings::recover_stranded_in_progress_jobs`]) and then drains
    /// normally through the ordinary claim → embed → write pipeline.
    #[test]
    fn embedding_worker_stranded_in_progress_job_recovers_and_drains_normally() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed for this recovery test.",
        );
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        // Claim flips status to `in_progress`; never finish it — mirrors
        // what a worker tick observing a cancel mid-`select!` leaves
        // behind (see `commands::ai::run_worker_tick_inner`).
        let claimed =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].status, "in_progress");
        assert_eq!(
            embedder.call_count(),
            0,
            "nothing embedded yet — the job was only claimed, then abandoned"
        );

        // Worker start: recover any stranded in_progress rows before
        // draining anything this run.
        let recovered = embeddings::recover_stranded_in_progress_jobs(&conn, 2_000).unwrap();
        assert_eq!(recovered, 1);
        let job = embeddings::get_embedding_job(&conn, "e1", &model_id)
            .unwrap()
            .expect("job row still present");
        assert_eq!(job.status, "pending");

        // Drains normally afterward through the ordinary pipeline.
        let outcomes = indexer.process_due_jobs(&conn, 10).unwrap();
        assert_eq!(outcomes.len(), 1);
        assert!(matches!(outcomes[0], JobOutcome::Completed { .. }));
        assert!(
            !embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .is_empty(),
            "recovered job embeds normally once drained"
        );
    }

    // ── Task 7: split-lock twin + soft-delete-mid-embed + C2 pre-embed ─
    //
    // `cargo test embedding_worker` also selects these.

    /// Split-lock twin of `embedding_worker_too_short_entry_is_skipped_with_zero_calls`:
    /// the too-short skip must also fire on the production
    /// `claim_and_plan_batch` path (previously only the single-conn
    /// `index_claimed_job` branch was covered).
    #[test]
    fn embedding_worker_claim_and_plan_batch_skips_too_short_entry_with_zero_db_writes() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        insert_entry(&conn, "e1", "", "hi"); // well under AI_ENTRY_EMBED_MIN_CHARS
        let model_id = "count-stub";
        embeddings::mark_entry_embedding_dirty(&conn, "e1", model_id, "irrelevant-hash", 0, 0)
            .unwrap();

        let claimed = claim_and_plan_batch(&conn, model_id, 10, 10).unwrap();
        assert!(
            claimed.is_empty(),
            "a too-short entry must never surface as a plan to embed"
        );

        let status: String = conn
            .query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id=?1",
                params![model_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "skipped");
    }

    /// `finish_claimed_job`'s `current_whole_entry_hash == None` branch
    /// (Task 7, previously untested): the entry is soft-deleted AFTER
    /// planning but BEFORE the write-back — must resolve to a clean
    /// `Skipped`, never an error, and must not write any chunk.
    #[test]
    fn embedding_worker_entry_soft_deleted_mid_embed_resolves_to_clean_skipped() {
        let conn = open_test_db();
        let indexer = EntryIndexer::from_dyn(Arc::new(CountingEmbedder::new("model-a", 8)))
            .with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed before it gets deleted.",
        );
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);

        let plan = plan_chunk_diff(&conn, "e1", &model_id).unwrap();
        assert!(!plan.to_embed.is_empty());
        let embedded: Vec<Vec<f32>> = plan.to_embed.iter().map(|_| vec![0.1; 8]).collect();
        let claimed = ClaimedJobPlan {
            job: jobs[0].clone(),
            plan,
        };

        // Soft-delete lands here — strictly AFTER planning, BEFORE the
        // write-back — the exact window `current_whole_entry_hash`
        // re-checks fresh at write time.
        conn.execute("UPDATE entries SET is_deleted = 1 WHERE id = 'e1'", [])
            .unwrap();

        let outcome = finish_claimed_job(&conn, &claimed, &model_id, Ok(embedded)).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e1".to_string()
            }
        );
        assert!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .is_empty(),
            "no chunk may be written for an entry deleted mid-embed"
        );
        let status: String = conn
            .query_row(
                "SELECT status FROM entry_embedding_jobs WHERE entry_id='e1' AND model_id=?1",
                params![model_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "skipped");
    }

    /// C2 hardened pre-embed guard: a job claimed WHILE the entry was
    /// still unlocked (passing the claim-time filter) must still be
    /// blocked if a lock lands AFTER claim but BEFORE the embed call —
    /// content-hash race guards do not catch this (locking doesn't change
    /// content), so `plan_chunk_diff`'s own re-check is the real
    /// guarantee.
    #[test]
    fn embedding_worker_locked_between_claim_and_embed_is_skipped_pre_embed_with_zero_calls() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed before locking.",
        );
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        // Claim while still unlocked — passes the claim-time filter.
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);

        // Lock lands AFTER claim, BEFORE the worker embeds.
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'e1'", [])
            .unwrap();

        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e1".to_string()
            }
        );
        assert_eq!(
            embedder.call_count(),
            0,
            "a lock landing between claim and embed must still block the provider call"
        );
        assert!(embeddings::list_stored_chunks(&conn, "e1", &model_id)
            .unwrap()
            .is_empty());
    }

    /// C2 hardened guard, the REAL production split-lock gap: a lock
    /// landing AFTER `claim_and_plan_batch` planned an entire multi-job
    /// batch under one lock, but BEFORE the SECOND job's own (sequential,
    /// per-job) embed call — `ChunkDiffPlan::is_locked_excluded` cannot
    /// see this, since it's a snapshot taken before ANY job in the batch
    /// was embedded. `finish_claimed_job`'s write-time re-check
    /// (`current_whole_entry_hash_and_lock`) must still catch it.
    #[test]
    fn embedding_worker_locked_after_batch_plan_but_before_own_turn_is_skipped_at_write_time() {
        let conn = open_test_db();
        let indexer = EntryIndexer::from_dyn(Arc::new(CountingEmbedder::new("model-a", 8)))
            .with_throttle(Duration::ZERO);
        insert_entry(&conn, "e1", "", "First entry text long enough to embed.");
        insert_entry(&conn, "e2", "", "Second entry text long enough to embed.");
        enable_local_background_indexing(&conn);
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");
        queue_dirty_job(&conn, &model_id, "e2");

        // Both entries are unlocked at plan time — the WHOLE batch is
        // planned together under one lock, mirroring
        // `run_worker_tick_inner`'s call to `claim_and_plan_batch`.
        let claimed = claim_and_plan_batch(&conn, &model_id, 10, 10).unwrap();
        assert_eq!(claimed.len(), 2);
        for c in &claimed {
            assert!(
                !c.plan.is_locked_excluded,
                "both entries were unlocked when the batch was planned"
            );
        }
        let second = claimed
            .iter()
            .find(|c| c.job.entry_id == "e2")
            .expect("e2 must be in the batch");

        // e1's own embed call happens first in the real worker loop —
        // simulated here by simply advancing time: e2 gets locked AFTER
        // planning but BEFORE e2's own turn.
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'e2'", [])
            .unwrap();

        let embedded: Vec<Vec<f32>> = second.plan.to_embed.iter().map(|_| vec![0.5; 8]).collect();
        let outcome = finish_claimed_job(&conn, second, &model_id, Ok(embedded)).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e2".to_string()
            },
            "a lock landing between batch-plan-time and this job's own embed turn must \
             still resolve to Skipped, not Completed"
        );
        assert!(
            embeddings::list_stored_chunks(&conn, "e2", &model_id)
                .unwrap()
                .is_empty(),
            "no chunk may be written for e2 once it's locked, even though its plan \
             (taken before ANY job in the batch embedded) said it was fine"
        );
    }

    /// C2 claim-time regression: a dirty job seeded while an entry was
    /// UNLOCKED must not be embedded once the entry becomes locked before
    /// the worker gets to it — end-to-end via `process_worker_batch`, the
    /// exact mechanism the continuous worker uses.
    #[test]
    fn embedding_worker_job_seeded_while_unlocked_is_not_embedded_after_locking() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed while unlocked.",
        );
        let model_id = indexer.model_id();
        // Dirty job seeded while the entry was still unlocked (mirrors
        // the save-path hook).
        queue_dirty_job(&conn, &model_id, "e1");

        // Locked AFTER the job was seeded, BEFORE the worker's next tick.
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'e1'", [])
            .unwrap();

        let outcomes = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        assert!(
            outcomes.is_empty(),
            "a job for a now-locked entry must never surface as a processed outcome"
        );
        assert_eq!(
            embedder.call_count(),
            0,
            "the now-locked entry must never reach the embed provider"
        );
        assert!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .is_empty(),
            "no chunks may be written for the now-locked entry"
        );
    }

    /// Invisible entries are excluded even when `ai_embed_include_protected`
    /// is true — the asymmetry established for `list_entries_needing_index`
    /// (invisible ALWAYS excluded; locked excluded unless include_protected)
    /// must hold at the claim-time layer too.
    #[test]
    fn embedding_worker_invisible_entry_never_claimed_even_with_include_protected() {
        let conn = open_test_db();
        crate::db::queries::set_setting(
            &conn,
            crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
            "true",
        )
        .unwrap();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "e1",
            "",
            "Entry text long enough to embed while visible.",
        );
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        conn.execute("UPDATE entries SET is_invisible = 1 WHERE id = 'e1'", [])
            .unwrap();

        let jobs = embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, true).unwrap();
        assert!(
            jobs.is_empty(),
            "invisible entries must never be claimed, even with include_protected=true"
        );
        assert_eq!(embedder.call_count(), 0);
    }

    // ── Phase 2 Task 4: debounce, throttle, backoff, consent gate ──────
    //
    // `cargo test embedding_worker` also selects these.

    /// Pure backoff schedule: 1m / 5m / 15m / 1h+ for the 1st/2nd/3rd/4th+
    /// failed attempt.
    #[test]
    fn embedding_worker_backoff_schedule_is_1m_5m_15m_1h() {
        assert_eq!(backoff_secs_for_attempt(1), 60);
        assert_eq!(backoff_secs_for_attempt(2), 300);
        assert_eq!(backoff_secs_for_attempt(3), 900);
        assert_eq!(backoff_secs_for_attempt(4), 3600);
        assert_eq!(backoff_secs_for_attempt(9), 3600, "caps at 1h");
    }

    /// Embedder that always fails with a configurable error — used to drive
    /// the backoff / auth-stop tests without a real provider.
    struct FailingEmbedder {
        model_id: String,
        error: AiError,
    }

    impl crate::ai::embedder::Embedder for FailingEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            8
        }
        fn embed(&self, _text: &str) -> Result<Vec<f32>, AiError> {
            Err(self.error.clone())
        }
    }

    /// A transient provider error (e.g. `ProviderError`) advances the job's
    /// `next_attempt_at` by the backoff schedule and bumps `attempt_count`,
    /// but keeps the job retryable (`status = 'error'`, still claimable).
    #[test]
    fn embedding_worker_transient_error_advances_backoff_and_stays_retryable() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "", "Entry text long enough to embed.");
        let indexer = EntryIndexer::from_dyn(Arc::new(FailingEmbedder {
            model_id: "count-stub".into(),
            error: AiError::ProviderError("simulated 500".into()),
        }))
        .with_throttle(Duration::ZERO);
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        let before = chrono::Utc::now().timestamp();
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert!(matches!(outcome, JobOutcome::Failed { .. }));

        let job = embeddings::get_embedding_job(&conn, "e1", &model_id)
            .unwrap()
            .expect("job row still present");
        assert_eq!(job.status, "error");
        assert_eq!(job.attempt_count, 1);
        assert!(
            job.next_attempt_at.unwrap() >= before + 60,
            "first failure backs off ~1m: got {:?}",
            job.next_attempt_at
        );

        // A transient error is NOT excluded from the next claim — 'error'
        // stays in `claim_due_embedding_jobs`'s pending/error filter.
        let still_claimable = embeddings::claim_due_embedding_jobs(
            &conn,
            &model_id,
            10,
            job.next_attempt_at.unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            still_claimable.len(),
            1,
            "transient error must stay retryable"
        );
    }

    /// An auth-class error (bad/expired API key) pauses the job instead of
    /// scheduling another retry — `status = 'paused'`, excluded from the
    /// next claim regardless of how far `now` advances.
    #[test]
    fn embedding_worker_auth_error_pauses_job_and_stops_auto_retry() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "", "Entry text long enough to embed.");
        let indexer = EntryIndexer::from_dyn(Arc::new(FailingEmbedder {
            model_id: "count-stub".into(),
            error: AiError::AuthFailed,
        }))
        .with_throttle(Duration::ZERO);
        let model_id = indexer.model_id();
        queue_dirty_job(&conn, &model_id, "e1");

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Paused {
                entry_id: "e1".to_string(),
                error: AiError::AuthFailed.to_string(),
            }
        );

        let job = embeddings::get_embedding_job(&conn, "e1", &model_id)
            .unwrap()
            .expect("job row still present");
        assert_eq!(job.status, "paused");

        // Even far in the future, a paused job is never re-claimed —
        // `claim_due_embedding_jobs` only selects 'pending'/'error'.
        let far_future = chrono::Utc::now().timestamp() + 10_000;
        let claimed =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, far_future, false).unwrap();
        assert!(
            claimed.is_empty(),
            "auth-class error must stop auto-retry — never re-claimed"
        );
    }

    // ── Phase 2 Task 3: opportunistic indexing while the app is open ───
    //
    // `cargo test embedding_worker` also selects these.

    fn set_entry_updated_at(conn: &Connection, id: &str, updated_at: i64) {
        conn.execute(
            "UPDATE entries SET updated_at = ?2 WHERE id = ?1",
            params![id, updated_at],
        )
        .expect("set updated_at");
    }

    // T2.3 cutover: `endpointClass` is no longer a stored per-slot row — it's
    // derived from the per-preset credential registry off the slot's
    // `provider` row. Seeding a `local`/`remote`-classified embed slot for
    // these gate tests means setting `PROVIDER` to a preset whose resolved
    // endpoint classifies that way ("ollama" defaults to a loopback URL,
    // "openai" to a public one) rather than writing a class string directly.
    fn enable_local_background_indexing(conn: &Connection) {
        crate::db::queries::set_setting(
            conn,
            crate::ai::provider::settings_keys::embed::PROVIDER,
            "ollama",
        )
        .unwrap();
        crate::db::queries::set_setting(
            conn,
            crate::ai::provider::settings_keys::BACKGROUND_INDEXING_ENABLED,
            "true",
        )
        .unwrap();
    }

    fn enable_hosted_background_indexing_without_consent(conn: &Connection) {
        crate::db::queries::set_setting(
            conn,
            crate::ai::provider::settings_keys::embed::PROVIDER,
            "openai",
        )
        .unwrap();
        crate::db::queries::set_setting(
            conn,
            crate::ai::provider::settings_keys::BACKGROUND_INDEXING_ENABLED,
            "true",
        )
        .unwrap();
    }

    /// Idle-time opportunistic indexing: several never-embedded entries,
    /// local provider (auto-allowed under `background_indexing_allowed`),
    /// background indexing enabled. The worker indexes them recency-first
    /// (by the owning entry's `updated_at`) and every one ends up with
    /// stored chunks.
    #[test]
    fn embedding_worker_opportunistic_indexes_recency_first_when_idle() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        insert_entry(&conn, "old", "", "Oldest entry text long enough to embed.");
        insert_entry(&conn, "mid", "", "Middle entry text long enough to embed.");
        insert_entry(&conn, "new", "", "Newest entry text long enough to embed.");
        set_entry_updated_at(&conn, "old", 100);
        set_entry_updated_at(&conn, "mid", 200);
        set_entry_updated_at(&conn, "new", 300);

        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);

        let outcomes = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        let ids: Vec<String> = outcomes
            .iter()
            .map(|o| match o {
                JobOutcome::Completed { entry_id, .. } => entry_id.clone(),
                other => panic!("expected Completed, got {other:?}"),
            })
            .collect();
        assert_eq!(
            ids,
            vec!["new".to_string(), "mid".to_string(), "old".to_string()],
            "opportunistic indexing processes the most recently edited entries first"
        );

        let model_id = indexer.model_id();
        for id in ["old", "mid", "new"] {
            assert!(
                !embeddings::list_stored_chunks(&conn, id, &model_id)
                    .unwrap()
                    .is_empty(),
                "{id} must end up with stored chunks"
            );
        }
    }

    /// Hosted provider, no consent recorded: opportunistic indexing makes
    /// ZERO embedding calls and leaves eligible entries un-embedded — the
    /// same gate that protects dirty-driven indexing also covers idle-time
    /// indexing, never a bypass.
    #[test]
    fn embedding_worker_opportunistic_zero_calls_when_hosted_without_consent() {
        let conn = open_test_db();
        enable_hosted_background_indexing_without_consent(&conn);
        insert_entry(&conn, "e1", "", "Entry text long enough to embed.");
        insert_entry(&conn, "e2", "", "Another entry text long enough to embed.");

        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);

        let outcomes = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        assert!(
            outcomes.is_empty(),
            "hosted-without-consent must process nothing"
        );
        assert_eq!(
            embedder.call_count(),
            0,
            "hosted-without-consent must make zero provider calls"
        );

        let model_id = indexer.model_id();
        for id in ["e1", "e2"] {
            assert!(
                embeddings::list_stored_chunks(&conn, id, &model_id)
                    .unwrap()
                    .is_empty(),
                "{id} must stay un-embedded without consent"
            );
        }
    }

    /// An entry that already has up-to-date chunks must not be re-indexed
    /// by the opportunistic path (it has no due dirty job and
    /// `list_entries_needing_index` excludes entries that already have
    /// chunks) — zero additional calls for already-indexed entries.
    #[test]
    fn embedding_worker_opportunistic_does_not_double_index_already_indexed_entry() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(&conn, "e1", "", "Already indexed entry text.");
        indexer.index_one(&conn, "e1").unwrap();
        let calls_after_initial_index = embedder.call_count();
        assert!(calls_after_initial_index > 0);

        let outcomes = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        assert!(
            outcomes.is_empty(),
            "already-indexed entry has no due dirty job and is not a `list_entries_needing_index` candidate"
        );
        assert_eq!(
            embedder.call_count(),
            calls_after_initial_index,
            "no additional provider calls for an already-indexed entry"
        );
    }

    /// A brand-new, actively-edited entry has zero chunks (so it's a
    /// `list_entries_needing_index` candidate) AND a save-path dirty job
    /// waiting out its own debounce window (future `next_attempt_at`). The
    /// opportunistic path must leave it alone — never yank a mid-debounce
    /// entry forward to "now" just because it also looks unindexed.
    #[test]
    fn embedding_worker_opportunistic_does_not_override_pending_debounce() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(
            &conn,
            "editing",
            "",
            "Actively edited entry text right now.",
        );
        set_entry_updated_at(&conn, "editing", 500);

        // Simulate the save-path hook: dirty-mark with a debounce window
        // far in the future.
        let far_future = chrono::Utc::now().timestamp() + 300;
        let model_id = indexer.model_id();
        embeddings::mark_entry_embedding_dirty(
            &conn,
            "editing",
            &model_id,
            "content-hash-mid-edit",
            far_future,
            chrono::Utc::now().timestamp(),
        )
        .unwrap();

        let outcomes = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        assert!(
            outcomes.is_empty(),
            "mid-debounce entry must not be opportunistically pulled forward"
        );
        assert_eq!(
            embedder.call_count(),
            0,
            "waiting-on-its-own-debounce entry must cost zero provider calls"
        );

        let job = embeddings::get_embedding_job(&conn, "editing", &model_id)
            .unwrap()
            .expect("job row still present");
        assert_eq!(
            job.next_attempt_at,
            Some(far_future),
            "the entry's own debounce window must be left untouched"
        );
        assert!(
            embeddings::list_stored_chunks(&conn, "editing", &model_id)
                .unwrap()
                .is_empty(),
            "must stay un-embedded until its own debounce elapses"
        );
    }

    /// Modal Pause (`pause_scope=sync_backfill`) must not opportunistic-seed
    /// never-indexed (sync-origin) rows. Already-queued LocalDirty jobs may
    /// still claim.
    #[test]
    fn embedding_worker_opportunistic_does_not_seed_untracked_under_pause_sync_backfill() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        insert_entry(
            &conn,
            "peer-stale",
            "",
            "Peer-stale never-indexed entry text long enough.",
        );
        insert_entry(
            &conn,
            "local-dirty",
            "",
            "Already-queued local dirty entry text long enough.",
        );
        crate::ai::embedding_decision::write_embed_sync_decision(
            &conn,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
            &crate::ai::embedding_decision::EmbedSyncDecision {
                state: crate::ai::embedding_decision::EmbedSyncDecisionState::Pause,
                pause_scope: crate::ai::embedding_decision::EmbedPauseScope::SyncBackfill,
                ..Default::default()
            },
        )
        .unwrap();

        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        let model_id = indexer.model_id();

        let idle = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        assert!(
            idle.is_empty(),
            "idle tick under Pause+sync_backfill must not opportunistic-seed"
        );
        assert!(
            embeddings::get_embedding_job(&conn, "peer-stale", &model_id)
                .unwrap()
                .is_none(),
            "pause_scope=sync_backfill must not opportunistic-seed never-indexed rows"
        );
        assert_eq!(embedder.call_count(), 0);

        queue_dirty_job(&conn, &model_id, "local-dirty");
        let outcomes = indexer.process_worker_batch(&conn, 10, 10).unwrap();
        let ids: Vec<&str> = outcomes
            .iter()
            .map(|o| match o {
                JobOutcome::Completed { entry_id, .. } => entry_id.as_str(),
                other => panic!("expected Completed, got {other:?}"),
            })
            .collect();
        assert_eq!(
            ids,
            vec!["local-dirty"],
            "already-queued LocalDirty may still claim under modal Pause"
        );
        assert!(
            embeddings::get_embedding_job(&conn, "peer-stale", &model_id)
                .unwrap()
                .is_none(),
            "claiming a LocalDirty job must still not seed peer-stale rows"
        );
    }

    // ─── enqueue_dirty_jobs_for_model (Phase 2 Task 6) ─────────────────────

    /// Every eligible entry gets a fresh `pending` job row for the given
    /// model_id, recency-first via `list_entries_needing_index`.
    #[test]
    fn embedding_worker_enqueue_dirty_jobs_for_model_queues_every_eligible_entry() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "T1", "First entry text long enough to embed.");
        insert_entry(&conn, "e2", "T2", "Second entry text long enough to embed.");

        let enqueued =
            enqueue_dirty_jobs_for_model(&conn, "openai:text-embedding-3-small").unwrap();

        assert_eq!(enqueued, 2);
        for id in ["e1", "e2"] {
            let job = embeddings::get_embedding_job(&conn, id, "openai:text-embedding-3-small")
                .unwrap()
                .expect("job row must exist for the new model");
            assert_eq!(job.status, "pending");
        }
    }

    /// An entry already indexed under `model_id` (has a stored chunk) is
    /// excluded — `list_entries_needing_index`'s anti-join, reused as-is.
    #[test]
    fn embedding_worker_enqueue_dirty_jobs_for_model_skips_already_indexed_entries() {
        let conn = open_test_db();
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(&conn, "already", "", "Already indexed entry text.");
        indexer.index_one(&conn, "already").unwrap();
        let model_id = indexer.model_id();

        let enqueued = enqueue_dirty_jobs_for_model(&conn, &model_id).unwrap();

        assert_eq!(
            enqueued, 0,
            "an entry already indexed under this model_id must not be re-queued"
        );
    }

    /// Enqueueing dirty jobs for a NEW model_id never reads, claims, or
    /// deletes the job rows already sitting under an OLD model_id —
    /// `entry_embedding_jobs` is keyed by `(entry_id, model_id)`, and the
    /// old rows must survive untouched so nothing re-embeds them.
    #[test]
    fn embedding_worker_enqueue_dirty_jobs_for_model_leaves_old_model_jobs_untouched() {
        let conn = open_test_db();
        insert_entry(&conn, "e1", "T1", "Entry text long enough to embed.");
        let old_model_id = "openai:text-embedding-3-small";
        let new_model_id = "openai:text-embedding-3-large";

        let enqueued_old = enqueue_dirty_jobs_for_model(&conn, old_model_id).unwrap();
        assert_eq!(enqueued_old, 1);

        let enqueued_new = enqueue_dirty_jobs_for_model(&conn, new_model_id).unwrap();
        assert_eq!(enqueued_new, 1);

        let old_job = embeddings::get_embedding_job(&conn, "e1", old_model_id)
            .unwrap()
            .expect("old-model job row must remain");
        assert_eq!(old_job.status, "pending");
        let new_job = embeddings::get_embedding_job(&conn, "e1", new_model_id)
            .unwrap()
            .expect("new-model job row must be enqueued");
        assert_eq!(new_job.status, "pending");
    }

    /// C11 regression: switch A → B → edit + index under B → switch back to
    /// A. Model A's pre-edit chunk rows still exist, so the entry must not
    /// be silently skipped as "already indexed" — it has to be re-queued
    /// under A so retrieval stops serving the stale pre-edit vectors.
    ///
    /// Goes through the real claimed-job pipeline (`claim_due_embedding_jobs`
    /// + `index_claimed_job`), not `index_one`, so the job row actually
    /// reaches `indexed` status the way production does — `index_one` is a
    /// test-only convenience that never touches `entry_embedding_jobs`.
    #[test]
    fn embedding_worker_enqueue_dirty_jobs_for_model_reactivates_stale_entry_on_switch_back() {
        let conn = open_test_db();
        insert_entry(
            &conn,
            "e1",
            "T1",
            "Original entry text long enough to embed.",
        );

        let indexer_a =
            EntryIndexer::from_dyn(Arc::new(StubEmbedder::new("model-a", 8)) as DynEmbedder)
                .with_throttle(Duration::ZERO);
        let model_a = indexer_a.model_id();
        queue_dirty_job(&conn, &model_a, "e1");
        let jobs_a =
            embeddings::claim_due_embedding_jobs(&conn, &model_a, 10, 1_000, false).unwrap();
        assert_eq!(jobs_a.len(), 1);
        indexer_a.index_claimed_job(&conn, &jobs_a[0]).unwrap();
        assert_eq!(
            embeddings::get_embedding_job(&conn, "e1", &model_a)
                .unwrap()
                .unwrap()
                .status,
            "indexed"
        );

        // Edit — content changes, and updated_at moves past any real-time
        // `indexed_at` written by `index_claimed_job` above (which stamps
        // `chrono::Utc::now()`, not this test's synthetic `1_000`).
        conn.execute(
            "UPDATE entries SET content_text = 'Edited entry text, now different and still long enough.', \
             updated_at = 9999999999 WHERE id = 'e1'",
            [],
        )
        .unwrap();

        let indexer_b =
            EntryIndexer::from_dyn(Arc::new(StubEmbedder::new("model-b", 8)) as DynEmbedder)
                .with_throttle(Duration::ZERO);
        let model_b = indexer_b.model_id();
        queue_dirty_job(&conn, &model_b, "e1");
        let jobs_b =
            embeddings::claim_due_embedding_jobs(&conn, &model_b, 10, 1_000, false).unwrap();
        assert_eq!(jobs_b.len(), 1);
        indexer_b.index_claimed_job(&conn, &jobs_b[0]).unwrap();

        // Switch back to model A.
        let enqueued = enqueue_dirty_jobs_for_model(&conn, &model_a).unwrap();
        assert_eq!(
            enqueued, 1,
            "old behavior would skip this entry since it already has an 'indexed' job row for A; \
             it must now be re-queued because A's chunks predate the edit"
        );
        assert_eq!(
            embeddings::get_embedding_job(&conn, "e1", &model_a)
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
    }

    // ── C11 skip-path perpetual churn fix (docs/later) ──────────────────

    /// Content-based skip: an entry indexed under model M, then edited down
    /// below `AI_ENTRY_EMBED_MIN_CHARS`, must have its stale chunk rows
    /// pruned as part of the skip, must drop out of
    /// `list_entries_needing_index`, and must not be re-claimed on a second
    /// cycle — otherwise `pending_embed_count` never reaches 0 and the
    /// worker claims/plans/skips this entry forever.
    #[test]
    fn embedding_worker_content_skip_prunes_stale_chunks_and_stops_being_listed() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(&conn, "e1", "", "Original entry text long enough to embed.");
        indexer.index_one(&conn, "e1").unwrap();
        let model_id = indexer.model_id();
        assert_eq!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .len(),
            1,
            "sanity: entry starts out indexed"
        );

        // Edit down below AI_ENTRY_EMBED_MIN_CHARS. `updated_at` is left at
        // its default (0) — the skip-exclusion check below only needs the
        // skip's own `updated_at` (stamped at real wall-clock time when
        // `skip_embedding_job` runs) to be at least as recent as the
        // entry's last edit, which trivially holds here.
        conn.execute("UPDATE entries SET content_text = 'hi' WHERE id = 'e1'", [])
            .unwrap();
        queue_dirty_job(&conn, &model_id, "e1");

        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);
        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e1".to_string()
            }
        );

        assert!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id)
                .unwrap()
                .is_empty(),
            "stale chunk rows must be pruned once the entry is too short to embed"
        );
        assert!(
            embeddings::list_entries_needing_index(&conn, &model_id, 10, false)
                .unwrap()
                .is_empty(),
            "a chunk-less, too-short entry must not be re-listed as needing index"
        );

        // Second cycle: nothing left to claim.
        let claimed_again = claim_and_plan_batch(&conn, &model_id, 10, 10).unwrap();
        assert!(
            claimed_again.is_empty(),
            "second cycle must claim nothing once the skip has been resolved"
        );
    }

    /// Locked-excluded skip: an entry indexed under model M, edited while
    /// still unlocked (so the job gets claimed), then locked before its own
    /// turn is planned — chunk rows must be KEPT (documented design: the
    /// read-side lock filter is the guarantee), the entry must drop out of
    /// `list_entries_needing_index` while locked, and a second cycle must
    /// claim nothing. Unlocking (still stale) must re-surface it.
    #[test]
    fn embedding_worker_locked_skip_keeps_chunks_and_reappears_after_unlock() {
        let conn = open_test_db();
        enable_local_background_indexing(&conn);
        let embedder = Arc::new(CountingEmbedder::new("count-stub", 8));
        let indexer =
            EntryIndexer::from_dyn(embedder.clone() as DynEmbedder).with_throttle(Duration::ZERO);
        insert_entry(&conn, "e1", "", "Original entry text long enough to embed.");
        indexer.index_one(&conn, "e1").unwrap();
        let model_id = indexer.model_id();
        let chunks_before = embeddings::list_stored_chunks(&conn, "e1", &model_id).unwrap();
        assert_eq!(chunks_before.len(), 1);

        // Edit while still unlocked (real content, still long enough), then
        // dirty-mark — mirrors the save-path hook running before the lock.
        conn.execute(
            "UPDATE entries SET content_text = 'Edited entry text, still long enough to embed.', \
             updated_at = 9999999999 WHERE id = 'e1'",
            [],
        )
        .unwrap();
        queue_dirty_job(&conn, &model_id, "e1");

        // Claim while still unlocked.
        let jobs =
            embeddings::claim_due_embedding_jobs(&conn, &model_id, 10, 1_000, false).unwrap();
        assert_eq!(jobs.len(), 1);

        // Lock lands AFTER claim, BEFORE this job's own plan/embed turn —
        // `ai_embed_include_protected` stays off (default).
        conn.execute("UPDATE entries SET is_locked = 1 WHERE id = 'e1'", [])
            .unwrap();

        let outcome = indexer.index_claimed_job(&conn, &jobs[0]).unwrap();
        assert_eq!(
            outcome,
            JobOutcome::Skipped {
                entry_id: "e1".to_string()
            }
        );

        assert_eq!(
            embeddings::list_stored_chunks(&conn, "e1", &model_id).unwrap(),
            chunks_before,
            "locked-excluded skip must keep the stored vectors as-is"
        );
        assert!(
            embeddings::list_entries_needing_index(&conn, &model_id, 10, false)
                .unwrap()
                .is_empty(),
            "a locked entry (include_protected off) must not be listed as needing index"
        );

        // Second cycle: nothing claimable while locked.
        let claimed_again = claim_and_plan_batch(&conn, &model_id, 10, 10).unwrap();
        assert!(
            claimed_again.is_empty(),
            "a locked entry must never be claimed while include_protected is off"
        );

        // Unlock — still stale (updated_at bumped past indexed_at), must
        // reappear.
        conn.execute("UPDATE entries SET is_locked = 0 WHERE id = 'e1'", [])
            .unwrap();
        let needing = embeddings::list_entries_needing_index(&conn, &model_id, 10, false).unwrap();
        assert_eq!(
            needing,
            vec!["e1".to_string()],
            "unlocking a still-stale entry must re-surface it"
        );
    }
}
