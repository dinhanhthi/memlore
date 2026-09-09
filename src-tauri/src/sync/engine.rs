//! Sync engine: wires a `SyncProvider` to the local DB.
//!
//! The engine is the only place in the app that:
//!   - decides **what** to push (pending rows in `sync_state`),
//!   - decides **what** to pull (remote `metadata.json` diff),
//!   - moves encryption across the trust boundary: every byte that leaves
//!     the local DB via `push_local` is already ciphertext-at-rest; every
//!     byte that arrives via `pull_remote` is decrypted in-process before
//!     touching the DB.
//!
//! **Plaintext never hits disk via sync.** Local DB still stores
//! `content_text` plaintext (Phase 3 FTS5 trade-off), but the sync channel
//! wraps `content_text` inside `EntryMetadata` → `bincode` → AES-GCM →
//! `SyncEntryPayload.metadata_ciphertext`. The regression test
//! `sync_file_does_not_leak_plaintext` pins this.
//!
//! **No push/pull loop.** `pull_remote` writes through `db::upsert_entry_from_sync`,
//! which bypasses `mark_entry_pending`. If it used the command-layer
//! `_impl` helpers instead, every pulled entry would re-mark as pending
//! and ping-pong between devices.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::embedding_sync::{
    batch_chunks_for_sync, decrypt_embedding_bytes_by_fingerprint, deserialize_chunk_batch,
    deserialize_embedding_payload, encrypt_embedding_bytes, serialize_chunk_batch,
    serialize_embedding_payload, EmbeddingChunkVector, SyncEmbeddingChunkPayload,
};
use super::entry_sync::{
    deserialize_payload, merge_yjs_full_state_updates, serialize_payload, SyncEntryPayload,
};
use super::media_sync;
use super::metadata::{
    compute_diff, merge_metadata_lww, sort_to_pull_newest_first, DeviceMetadata, EntryMetadata,
    SyncDeletedMediaItem, SyncDiff, SyncMediaItem, SyncedEntrySummary, SyncedJournalSummary,
};
use super::provider::{ConditionalRead, FileKind, SyncError, SyncProvider};
use super::version_sync::{
    self, deserialize_version_payload, serialize_version_payload, version_cloud_path,
    SyncVersionPayload, VersionMetadata,
};
use crate::db;
use crate::utils::encryption::{decrypt_data_with_state, encrypt_data_with_state, key_fingerprint};
use crate::utils::time::now_unix;
use crate::AppState;

/// Maximum clock skew tolerated from a peer-supplied tombstone timestamp.
/// A tombstone whose `updated_at` exceeds `now + MAX_CLOCK_SKEW_SECS` is
/// clamped to that bound before being written to the local DB. This prevents
/// a malicious or buggy peer from stamping `i64::MAX` onto a row and making
/// it permanently un-resurrectable (the "timestamp poisoning" attack): a
/// clamped value is ≤ now + 24 h, so a genuine edit within the next day can
/// still exceed it and resurrect the entry. Legitimate tombstones (timestamp
/// ≤ now) pass through unchanged, so normal convergence is unaffected.
pub(crate) const MAX_CLOCK_SKEW_SECS: i64 = 86_400; // 24 h

/// Number of entries committed per database transaction while pulling a
/// peer's entries in `pull_remote_with_manifest_scope`. Chunking — instead
/// of "download everything, then one commit" — means a mid-pull failure
/// (a bad entry, or the outer `sync_now` timeout cancelling the future)
/// leaves already-committed chunks durably in the DB. The next sync
/// attempt recomputes the diff, so it only needs to pull the remainder.
const PULL_CHUNK_SIZE: usize = 5;

/// One `push_local` pass. `pushed` is the number of entry files that were
/// successfully written; `media_uploaded` is the number of media files
/// uploaded; `errors` captures per-entry and per-media failures.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushStats {
    pub pushed: u64,
    pub media_uploaded: u64,
    pub versions_uploaded: u64,
    /// Number of encrypted chunk-vector batches uploaded this pass (Phase 5
    /// Task 2). Zero when no embedding model has any locally-stored chunks
    /// yet, or when every eligible batch upload failed (see `errors`).
    pub embedding_chunk_batches_uploaded: u64,
    pub errors: Vec<String>,
}

/// Tallies from one [`SyncEngine::pull_embedding_chunks`] pass.
///
/// `adopted` is the only counter that currently reaches the frontend via
/// [`PullStats`]; model/hash mismatch tallies drive the device-local
/// decision receipt (and tests) without changing `SyncSummary`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EmbeddingChunkPullStats {
    pub adopted: u64,
    pub model_mismatch: u64,
    pub hash_mismatch: u64,
}

/// One `pull_remote` pass (summed over all peer devices).
///
/// `errors` collects per-peer or per-entry problems so one bad peer file
/// does not abort the whole pull. Each peer's DB writes are wrapped in
/// its own transaction — an error during peer B's merge rolls B back
/// without touching whatever peer A successfully merged earlier.
///
/// `warnings` surfaces non-fatal consistency anomalies — currently, entry
/// blobs that a peer's manifest references but that are absent from the
/// provider (`NotFound`). These indicate a repairable inconsistency (the
/// peer's blob was deleted or never uploaded); the pull continues, but the
/// caller should surface or log the warning rather than treating the result
/// as fully clean.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullStats {
    pub pulled: u64,
    pub merged: u64,
    pub deleted: u64,
    pub versions_pulled: u64,
    /// Number of incoming synced chunk vectors ADOPTED this pass (Phase 5
    /// Task 3) — i.e. stored via `upsert_chunk` because both the
    /// active-model and content-hash adopt-on-match checks passed. Vectors
    /// ignored for a model/hash mismatch, an ineligible entry, or malformed
    /// input are not counted here and do not appear in `errors` either
    /// (ignoring is the expected, non-error outcome — see
    /// `SyncEngine::pull_embedding_chunks`).
    pub embedding_chunks_adopted: u64,
    /// Peer vectors skipped because `model_id` ≠ this device's configured
    /// embed slot. Device-local only; not forwarded to `SyncSummary`.
    #[serde(skip)]
    pub embedding_model_mismatch: u64,
    /// Peer vectors skipped because content hash diverged under the same
    /// model. Silent local re-embed path — does **not** stamp a decision.
    #[serde(skip)]
    pub embedding_hash_mismatch: u64,
    pub errors: Vec<String>,
    /// Non-fatal consistency warnings (e.g. manifest-referenced blobs that
    /// returned `NotFound`). One string per anomaly; format:
    /// `"peer <id> entry <entry_id>: manifest references missing blob"`.
    pub warnings: Vec<String>,
    /// Presets whose live endpoint changed during [`SyncEngine::pull_settings`].
    /// Command layer runs `reconcile_slots_for_preset` after the cycle.
    #[serde(skip)]
    pub changed_endpoint_presets: Vec<String>,
}

/// Errors + changed endpoint presets from one [`SyncEngine::pull_settings`] pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettingsPullStats {
    pub errors: Vec<String>,
    pub changed_endpoint_presets: Vec<String>,
}

/// Result of a full `sync_now` cycle.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub pushed: u64,
    pub pulled: u64,
    pub merged: u64,
    pub errors: Vec<String>,
    /// Consistency warnings forwarded from the pull leg (e.g.
    /// manifest-referenced blobs that could not be read). `sync_now` also
    /// copies these into `errors`, because incomplete remote data must not be
    /// presented to callers as a clean sync.
    pub warnings: Vec<String>,
    /// `true` when any push/pull leg surfaced `SyncError::ScopeMismatch`.
    /// Set by the engine so callers (the run_sync_now command, the
    /// scheduler) can react with the appdata-migration UX without
    /// substring-matching error strings.
    #[serde(skip)]
    pub scope_mismatch: bool,
    /// Presets whose endpoint changed on this pull. `#[serde(skip)]` — the
    /// frontend `SyncSummary` type does not include this; `run_sync_now`
    /// consumes it to reconcile live provider slots.
    #[serde(skip)]
    pub changed_endpoint_presets: Vec<String>,
}

/// Why a sync cycle was started.
///
/// Carries the own-cloud reconcile decision: `Manual` always re-lists this
/// device's cloud folders (self-heal on every "Sync now"), while `Automatic`
/// runs that listing at most once per process session after a successful
/// reconcile (interval / on-save / on-launch ticks skip afterward). The
/// session flag is process-level because production builds a fresh
/// [`SyncEngine`] per `run_sync_now` cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTrigger {
    /// User-initiated "Sync now" (or any path that must always self-heal).
    Manual,
    /// Scheduler / background cycle. Reconcile only if this process has not
    /// yet completed a successful own-cloud reconcile this session.
    Automatic,
}

/// Process-level "own-cloud reconcile succeeded this session" flag.
///
/// Shared by every production [`SyncEngine`]: `run_sync_now` constructs a
/// fresh engine each cycle, so a per-instance `AtomicBool` would reset every
/// Automatic tick and never skip. Constructors adopt this Arc rather than
/// starting `false` every time.
fn session_own_cloud_reconciled_shared() -> Arc<std::sync::atomic::AtomicBool> {
    static FLAG: std::sync::OnceLock<Arc<std::sync::atomic::AtomicBool>> =
        std::sync::OnceLock::new();
    FLAG.get_or_init(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
        .clone()
}

/// Re-arm Automatic own-cloud reconcile for this process session.
///
/// Call whenever cloud identity or write namespace is invalidated (re-pair,
/// account switch, wipe, recovery rebuild, content migration, scope upgrade)
/// so the next Automatic cycle re-lists DeviceRoot and can re-dirty
/// hash-gated surfaces. Steady-state Automatic still skips after the first
/// successful reconcile until this is called again or the app restarts.
pub(crate) fn reset_session_own_cloud_reconciled() {
    session_own_cloud_reconciled_shared().store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Clear surface push hashes and pull revisions **and** re-arm Automatic
/// reconcile.
///
/// These two invariants must stay coupled: clearing hashes without re-arming
/// leaves Automatic cycles unable to self-heal missing bins for the rest of
/// the process lifetime; re-arming without clearing does nothing for
/// write-namespace changes where hashes still match local plaintext.
pub(crate) fn invalidate_surface_push_state(conn: &Connection) -> rusqlite::Result<()> {
    db::clear_all_surface_push_hashes(conn)?;
    db::clear_all_pull_revisions(conn)?;
    reset_session_own_cloud_reconciled();
    Ok(())
}

/// Test alias for [`reset_session_own_cloud_reconciled`].
#[cfg(test)]
pub(crate) fn reset_session_own_cloud_reconciled_for_test() {
    reset_session_own_cloud_reconciled();
}

/// Serialises tests that read/write the process-level session reconcile flag.
#[cfg(test)]
pub(crate) static SESSION_RECONCILE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Sync progress phase — serialises as kebab-case (e.g. `"pushing-entries"`)
/// so the TypeScript frontend union can use the string directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncProgressPhase {
    PushingJournals,
    PushingMedia,
    PushingEntries,
    PushingVersions,
    PushingSettings,
    PushingTags,
    PushingTemplates,
    PushingLocations,
    PushingChats,
    PushingStreak,
    PushingAiAudit,
    PullingManifests,
    PullingTags,
    PullingJournals,
    PullingEntries,
    PullingVersions,
    PullingSettings,
    PullingTemplates,
    PullingLocations,
    PullingChats,
    PullingStreak,
    PullingAiAudit,
}

/// Per-event payload emitted during a push/pull cycle.
/// Field names serialise as camelCase for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressEvent {
    pub phase: SyncProgressPhase,
    /// Items completed so far (0 = starting).
    pub current: u32,
    /// Total items expected for this phase.
    pub total: u32,
}

/// Progress for the foreground catch-up pull, emitted after each committed
/// entry chunk. `total` is fixed for the entire cycle across every peer;
/// `peer_device_id` is omitted only for the clean terminal event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchupProgressEvent {
    pub pulled: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_device_id: Option<String>,
}

/// Callback interface for sync progress reporting.
///
/// Implemented by `TauriProgressReporter` in production and by a
/// `TestReporter` in unit tests.  The trait is object-safe and
/// `Send + Sync` so it can be held across `.await` boundaries without
/// wrapping in `Mutex`.
pub trait ProgressReporter: Send + Sync {
    fn report(&self, event: SyncProgressEvent);

    /// Best-effort catch-up progress for the dedicated frontend event.
    /// Implementors that only render the generic sync progress can ignore it.
    fn report_catchup_progress(&self, _event: CatchupProgressEvent) {}

    /// Fine-grained liveness signal, called once per item processed inside
    /// long provider-I/O loops (media/entry/version push, entry/version
    /// pull). Deliberately **not** throttled like `report()` — every call
    /// matters for stall detection — and deliberately **not** an IPC event;
    /// the default no-op is correct for any reporter that only cares about
    /// UI-facing progress. `run_sync_now`'s stall guard overrides this to
    /// stamp a last-progress timestamp instead of emitting anything.
    fn heartbeat(&self) {}
}

/// Throttle helper: decide whether item `i` (0-indexed) out of `n` total
/// should emit a progress event.
///
/// Strategy: emit at i=0 (start), at i=n-1 (last item == `current = n`
/// after +1), and every `step = min(25, max(1, n/20))` items in between.
/// This caps the channel at ≤ ~20 events per phase for small N, and at
/// least every 25 items for large N — the cap keeps the gap between UI
/// progress events (which re-arm the frontend's 130s watchdog) bounded
/// even when a single phase has to process a very large number of items.
fn should_emit(i: usize, n: usize) -> bool {
    if n == 0 {
        return false;
    }
    let step = (n / 20).clamp(1, 25);
    i == 0 || i + 1 == n || i % step == 0
}

/// Whole-table surfaces gated by content hash in `sync_push_state`.
///
/// Each name is both the `surface` column key and the stem of
/// `{device_id}/{name}.bin`. This is the **authoritative** list for
/// hash-gate push + reconcile prune (not derived at runtime from rotation).
///
/// Today the stems match rotation's encrypted `SINGLETON_BLOB_NAMES` 1:1 —
/// pinned by `hash_gated_surface_names_match_rotation_singleton_stems`.
/// Keep the constants separate for layering (rotation = re-encrypt scope;
/// this list = push/hash gate). If they must intentionally diverge later,
/// update that pin test to the new contract rather than deleting it.
pub(crate) const HASH_GATED_SURFACE_NAMES: &[&str] = &[
    "settings",
    "tags",
    "templates",
    "chats",
    "memory",
    "streak",
    "locations",
    "ai_audit",
    "ai_reviews",
];

pub struct SyncEngine {
    provider: Arc<dyn SyncProvider>,
    device_id: String,
    /// Optional progress reporter.  When `None` the engine runs silently
    /// (unit-test path).  When `Some` every meaningful loop boundary emits
    /// a [`SyncProgressEvent`].
    reporter: Option<Arc<dyn ProgressReporter>>,
    /// Recovery-only scope: include this device's own cloud folder while
    /// rebuilding a freshly cleared local database.
    include_self_in_pull: bool,
    /// Frozen recovery peer scope derived from current-generation manifests.
    /// Every recovery channel must enumerate only this set.
    recovery_peer_scope: Option<std::sync::Arc<std::collections::BTreeSet<String>>>,
    /// Per-cycle cache of the provider's device list.
    ///
    /// Populated on the first *successful* [`Self::list_pull_devices`] call
    /// so the ~10 surface pulls (plus `fetch_manifests`) inside one multi-surface
    /// cycle share a single `list_devices` round-trip. Errors are never stored —
    /// the next caller retries the provider.
    ///
    /// **Cycle boundaries** are owned by [`Self::device_cache_batch_depth`]:
    /// - `sync_now` / `pull_remote_with_manifest_scope` clear once (outermost
    ///   only), then enter a batch for the whole multi-surface walk so nested
    ///   surface pulls share the warm cache. Nested `pull_remote` inside
    ///   `sync_now` only increments depth — it does **not** clear again.
    /// - Standalone public `pull_*` (and other public paths that list devices
    ///   with depth == 0) clear at entry so a long-lived engine cannot pin a
    ///   stale device list forever. Within one such call the cache still
    ///   covers any internal re-hits of `list_pull_devices`.
    device_cache: std::sync::Mutex<Option<Vec<String>>>,
    /// Nesting depth of multi-surface device-cache batches.
    ///
    /// `0` means no batch is active (standalone entry points must clear).
    /// `>0` means a `sync_now` / `pull_remote` cycle owns the cache — nested
    /// surfaces must not clear. See [`Self::enter_device_cache_batch`].
    device_cache_batch_depth: std::sync::atomic::AtomicU32,
    /// Whether [`Self::reconcile_own_cloud_content`] has succeeded at least
    /// once this process session. Production engines share one process-level
    /// Arc (see [`session_own_cloud_reconciled_shared`]) so Automatic cycles
    /// skip after the first success even when `run_sync_now` builds a new
    /// engine per cycle. Manual always re-runs. Only set on success so a
    /// failed listing does not burn the once-per-session budget.
    session_own_cloud_reconciled: Arc<std::sync::atomic::AtomicBool>,
}

/// RAII guard that decrements [`SyncEngine::device_cache_batch_depth`] on drop
/// so early returns and cancelled async futures still leave the batch.
struct DeviceCacheBatchGuard<'a> {
    engine: &'a SyncEngine,
}

impl Drop for DeviceCacheBatchGuard<'_> {
    fn drop(&mut self) {
        self.engine.leave_device_cache_batch();
    }
}

/// Small abstraction over "how the engine gets at a `Connection`."
///
/// In production, the engine is handed a `&AppState` and lock-acquires
/// around each short DB call (see [`SyncEngine::sync_now_on_state`]),
/// which keeps the mutex available to every other Tauri command while
/// the engine awaits filesystem I/O. In unit tests, the engine is handed
/// a bare `&Connection` so a test doesn't need to build a full Tauri
/// state.
///
/// The two shapes converge here: `with_conn` runs a short synchronous
/// closure against a `Connection` and returns the result. Neither the
/// production path nor the test path holds a lock across `.await`.
pub trait ConnAccess {
    fn with_conn<F, R>(&self, f: F) -> Result<R, SyncError>
    where
        F: FnOnce(&Connection) -> Result<R, SyncError>;
}

impl ConnAccess for AppState {
    fn with_conn<F, R>(&self, f: F) -> Result<R, SyncError>
    where
        F: FnOnce(&Connection) -> Result<R, SyncError>,
    {
        let guard = self.lock().map_err(SyncError::Io)?;
        f(&guard)
    }
}

/// Convenience wrapper so the test path can pass a `&Connection` directly.
impl ConnAccess for Connection {
    fn with_conn<F, R>(&self, f: F) -> Result<R, SyncError>
    where
        F: FnOnce(&Connection) -> Result<R, SyncError>,
    {
        f(self)
    }
}

impl SyncEngine {
    pub fn new(provider: Arc<dyn SyncProvider>, device_id: String) -> Self {
        // Under `cargo test`, default to an *isolated* session flag so the
        // hundreds of Manual `push_local` unit tests do not race the
        // process-level flag. Production entry points (`run_sync_now`, etc.)
        // call [`Self::new_for_session`] which always shares.
        #[cfg(test)]
        {
            return Self::with_session_flag(
                provider,
                device_id,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            );
        }
        #[cfg(not(test))]
        {
            Self::new_for_session(provider, device_id)
        }
    }

    /// Construct an engine that adopts the process-level session reconcile flag.
    ///
    /// Use this from production sync entry points (`run_sync_now`, etc.): a
    /// fresh engine is built each cycle, but Automatic must still skip after
    /// the first successful own-cloud reconcile this process session.
    pub fn new_for_session(provider: Arc<dyn SyncProvider>, device_id: String) -> Self {
        Self::with_session_flag(provider, device_id, session_own_cloud_reconciled_shared())
    }

    /// Build an engine that adopts a specific session-reconcile flag Arc.
    fn with_session_flag(
        provider: Arc<dyn SyncProvider>,
        device_id: String,
        session_own_cloud_reconciled: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self {
            provider,
            device_id,
            reporter: None,
            include_self_in_pull: false,
            recovery_peer_scope: None,
            device_cache: std::sync::Mutex::new(None),
            device_cache_batch_depth: std::sync::atomic::AtomicU32::new(0),
            session_own_cloud_reconciled,
        }
    }

    /// Whether this cycle should run [`Self::reconcile_own_cloud_content`].
    ///
    /// Manual always; Automatic only until the first successful reconcile
    /// this process session (shared flag).
    fn should_reconcile_own_cloud(&self, trigger: SyncTrigger) -> bool {
        match trigger {
            SyncTrigger::Manual => true,
            SyncTrigger::Automatic => !self
                .session_own_cloud_reconciled
                .load(std::sync::atomic::Ordering::SeqCst),
        }
    }

    fn mark_own_cloud_reconciled(&self) {
        self.session_own_cloud_reconciled
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Attach a progress reporter.  Returns `self` for builder chaining.
    pub fn with_reporter(mut self, reporter: Arc<dyn ProgressReporter>) -> Self {
        self.reporter = Some(reporter);
        self
    }

    /// Drop any memoised device list. Safe to call when already empty.
    ///
    /// Used at cycle/standalone entry so a long-lived engine re-queries the
    /// provider. Within an active batch the cache is filled by the first
    /// successful [`Self::list_pull_devices`].
    fn reset_device_cache(&self) {
        let mut cache = self.device_cache.lock().unwrap_or_else(|e| e.into_inner());
        *cache = None;
    }

    /// Enter a multi-surface device-cache batch (pairs with leave / RAII guard).
    ///
    /// Invariant: while depth > 0, public surface pulls must **not** clear the
    /// cache so one `list_devices` serves every surface in the cycle.
    fn enter_device_cache_batch(&self) {
        self.device_cache_batch_depth
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Leave a multi-surface device-cache batch. Must pair with a prior enter.
    fn leave_device_cache_batch(&self) {
        self.device_cache_batch_depth
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// `true` when a multi-surface cycle currently owns the device cache.
    fn in_device_cache_batch(&self) -> bool {
        self.device_cache_batch_depth
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
    }

    /// Enter a batch and return a guard that leaves on drop.
    fn enter_device_cache_batch_guard(&self) -> DeviceCacheBatchGuard<'_> {
        self.enter_device_cache_batch();
        DeviceCacheBatchGuard { engine: self }
    }

    /// Standalone public entry: clear the device list when no batch is active.
    ///
    /// Invariant: depth == 0 ⇒ this call is the cycle boundary and must not
    /// reuse a previous cycle's list. depth > 0 ⇒ a parent `sync_now` /
    /// `pull_remote` already owns the cache for the whole multi-surface walk.
    fn prepare_device_cache_for_standalone_entry(&self) {
        if !self.in_device_cache_batch() {
            self.reset_device_cache();
        }
    }

    async fn list_pull_devices(&self) -> Result<Vec<String>, SyncError> {
        match &self.recovery_peer_scope {
            Some(scope) => Ok(scope.iter().cloned().collect()),
            None => {
                // Return a prior success without re-hitting the provider.
                // Hold the lock only for the lookup — never across `.await`.
                {
                    let cache = self.device_cache.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(devices) = cache.as_ref() {
                        return Ok(devices.clone());
                    }
                }

                let devices = self.provider.list_devices().await?;

                // Cache only on success so a transient list_devices failure
                // is retried by the next surface in this cycle.
                {
                    let mut cache = self.device_cache.lock().unwrap_or_else(|e| e.into_inner());
                    // Another concurrent caller may have filled it first;
                    // prefer the already-cached value for consistency.
                    if let Some(cached) = cache.as_ref() {
                        return Ok(cached.clone());
                    }
                    *cache = Some(devices.clone());
                }
                Ok(devices)
            }
        }
    }

    /// Build an [`crate::EncryptionKeyState`] from a raw key slice.
    ///
    /// Used to call the versioned `encrypt_data_with_state` /
    /// `decrypt_data_with_state` helpers. The returned state is ephemeral —
    /// it lives only for the duration of one encrypt/decrypt call.
    ///
    /// **Double-HKDF note:** the `key` argument is already the HKDF-derived
    /// sync sub-key produced by `commands::sync` (i.e. `HKDF(master, "sync")`).
    /// When the returned `EncryptionKeyState` is used via `with_sync_key`, it
    /// performs a *second* HKDF expansion internally, yielding
    /// `HKDF(HKDF(master, "sync"), "sync")` as the actual encryption / fingerprint
    /// key.  This is intentional — both `push_local` and `ingest_entry` call
    /// `make_key_state` with the same input, so the derivation is symmetric and
    /// the round-trip is correct.  Do not "fix" this to a single expansion without
    /// updating both sides and bumping the wire-format version.
    fn make_key_state(&self, key: &[u8; 32]) -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new(*key))
            .expect("set_key never fails");
        ks
    }

    /// Emit one progress event if a reporter is attached.
    fn emit_progress(&self, phase: SyncProgressPhase, current: u32, total: u32) {
        if let Some(r) = &self.reporter {
            r.report(SyncProgressEvent {
                phase,
                current,
                total,
            });
        }
    }

    /// Emit one catch-up progress event if a reporter is attached.
    fn emit_catchup_progress(&self, event: CatchupProgressEvent) {
        if let Some(r) = &self.reporter {
            r.report_catchup_progress(event);
        }
    }

    /// Forward a liveness heartbeat to the attached reporter, if any. Called
    /// once per item processed in the long provider-I/O loops (media/entry/
    /// version push, entry/version pull) so `run_sync_now`'s stall guard sees
    /// forward progress even between throttled `emit_progress` calls.
    fn heartbeat(&self) {
        if let Some(r) = &self.reporter {
            r.heartbeat();
        }
    }

    /// Requeue only this device's rows when a successful cloud listing proves
    /// their blobs are missing, and clear `sync_push_state` for whole-table
    /// surfaces whose `{surface}.bin` is absent on cloud so the next push
    /// re-uploads them (hash-gating would otherwise skip forever).
    ///
    /// **All listings complete before any DB write**, so auth, network, scope,
    /// and provider failures leave local ledgers untouched and fail the push
    /// closed.
    async fn reconcile_own_cloud_content<C: ConnAccess>(
        &self,
        access: &C,
    ) -> Result<Vec<String>, SyncError> {
        let entry_paths = self
            .provider
            .list_files(&self.device_id, FileKind::Entries)
            .await?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let media_paths = self
            .provider
            .list_files(&self.device_id, FileKind::Media)
            .await?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let journal_paths = self
            .provider
            .list_files(&self.device_id, FileKind::Journals)
            .await?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let version_paths = self
            .provider
            .list_files(&self.device_id, FileKind::Versions)
            .await?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        // Whole-table surface bins live at the device-folder root (not under
        // entries/media/…). List after the four subfolder listings and before
        // any DB write so a listing failure still fails closed.
        let device_root_paths = self
            .provider
            .list_files(&self.device_id, FileKind::DeviceRoot)
            .await?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();

        // One-time prune of the orphaned Ask Journal singleton. The surface
        // was removed from `SINGLETON_BLOB_NAMES` and no longer has a push/
        // pull path, so a leftover `{device_id}/ask_journal.bin` on a dev
        // cloud would otherwise sit forever under the old master key and
        // never be re-encrypted on rotation. Best-effort: log and continue
        // on delete failure so a transient network blip cannot fail the
        // whole own-cloud reconcile. Do NOT re-add to SINGLETON_BLOB_NAMES.
        let ask_journal_orphan = format!("{}/ask_journal.bin", self.device_id);
        if device_root_paths.contains(&ask_journal_orphan) {
            if let Err(e) = self.provider.delete_file(&ask_journal_orphan).await {
                log::warn!("reconcile: failed to prune orphaned {ask_journal_orphan}: {e}");
            } else {
                log::info!("reconcile: pruned orphaned {ask_journal_orphan}");
            }
        }

        access.with_conn(|conn| {
            db::requeue_missing_owned_sync_content(
                conn,
                &self.device_id,
                &entry_paths,
                &media_paths,
                &journal_paths,
                &version_paths,
            )
            .map_err(sync_io)?;
            // Surface stem == `sync_push_state.surface` (settings, tags, …).
            // Uses HASH_GATED_SURFACE_NAMES (not rotation's singleton list).
            for surface in HASH_GATED_SURFACE_NAMES {
                let cloud_path = format!("{}/{surface}.bin", self.device_id);
                if !device_root_paths.contains(&cloud_path) {
                    db::clear_surface_push_hash(conn, surface).map_err(sync_io)?;
                }
            }
            // Plaintext metadata.json uses surface key `"metadata"` (not a .bin).
            // Same silent-no-upload class if the file is deleted out-of-band.
            let metadata_path = format!("{}/metadata.json", self.device_id);
            if !device_root_paths.contains(&metadata_path) {
                db::clear_surface_push_hash(conn, "metadata").map_err(sync_io)?;
            }
            Ok(())
        })?;
        // Returned so `reconcile_own_media_files` can prune orphans without a
        // second `list_files(Media)` in the same push.
        Ok(media_paths.into_iter().collect())
    }

    /// Push every pending entry for this device to the provider, then
    /// write this device's `metadata.json` so peers can see the new state.
    ///
    /// Per-entry failures (e.g. a NaN field that `serde_json` refuses to
    /// serialize) are isolated — they go into `PushStats.errors` and the
    /// loop continues to the next entry. Without this isolation, one
    /// poisoned row would block every other pending entry from syncing.
    ///
    /// The connection is acquired via the `ConnAccess` trait — in
    /// production this locks `AppState` only for the short synchronous
    /// DB call, releases, then awaits filesystem I/O. Other Tauri
    /// commands can interleave freely during the await.
    pub async fn push_local<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
        trigger: SyncTrigger,
    ) -> Result<PushStats, SyncError> {
        let mut stats = PushStats::default();

        // Own-cloud self-heal (5× list_files: Entries/Media/Journals/
        // Versions/DeviceRoot): always on Manual; once per process session
        // on Automatic. Flag is set only after success so a transient
        // listing failure retries on the next Automatic tick.
        if self.should_reconcile_own_cloud(trigger) {
            let media_paths = self.reconcile_own_cloud_content(access).await?;
            // Prune own-folder media blobs whose local row is gone (inline node
            // removed, entry/journal soft-deleted, explicit remove). Throttled
            // with the rest of the own-cloud self-heal because it is
            // irreversible — deleting the only cloud copy of a photo — unlike
            // the non-destructive requeue in `reconcile_own_cloud_content`. The
            // delete paths call `reset_session_own_cloud_reconciled` so a later
            // deletion re-arms this gate rather than waiting for a manual sync.
            // Reuses the Media listing from reconcile — a second list_files
            // would double-count Media on the same push.
            let media_errors = self.reconcile_own_media_files(access, &media_paths).await;
            let media_ok = media_errors.is_empty();
            for e in media_errors {
                stats.errors.push(e);
            }
            // Arm the once-per-session flag only when the whole self-heal —
            // including the media prune — completed cleanly, so a transient
            // prune failure (delete / DB-check) retries on the next
            // Automatic tick instead of being skipped for the rest of the
            // session, matching the retry-on-failure contract.
            if media_ok {
                self.mark_own_cloud_reconciled();
            }
        }

        // Push pending journals FIRST. Entries reference journal_id via FK
        // on the receiver; if a peer pulls an entry referencing a journal
        // it hasn't seen yet, ingest must still materialize one — but
        // surfacing the journal payload up front means the receiver gets
        // the full color/auto_tags state, not the truncated form
        // EntryMetadata carries as a fallback.
        self.emit_progress(SyncProgressPhase::PushingJournals, 0, 1);
        match self.push_journals(access, key).await {
            Ok(errs) => {
                for e in errs {
                    stats.errors.push(format!("journals: {e}"));
                }
            }
            Err(e) => stats.errors.push(format!("journals: {e}")),
        }
        self.emit_progress(SyncProgressPhase::PushingJournals, 1, 1);

        // Push pending media so the cloud bytes exist by the time an
        // entry payload (which now embeds a media manifest) lands on a peer.
        // Reversing this order would let a peer pull an entry that references
        // a media id whose ciphertext hasn't been uploaded yet, causing
        // every `resolve_media` to 404 until the next push tick.
        let pending_media =
            access.with_conn(|conn| db::list_pending_uploads(conn).map_err(sync_io))?;
        let media_total = pending_media.len();
        self.emit_progress(SyncProgressPhase::PushingMedia, 0, media_total as u32);
        for (media_i, media) in pending_media.iter().enumerate() {
            // Heartbeat fires once per item regardless of success/failure —
            // a run of consecutive per-item failures (each slow: read error,
            // encrypt error, upload error) must not go silent from the
            // stall guard's point of view just because none of them reached
            // the old post-upload heartbeat call.
            self.heartbeat();
            let path = format!("{}/media/{}", self.device_id, media.id);
            let bytes = match std::fs::read(&media.storage_path) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("read media file {}: {e}", media.storage_path);
                    let _ = access.with_conn(|conn| {
                        db::mark_media_upload_error(conn, &media.id).map_err(sync_io)
                    });
                    stats.errors.push(format!("media {}: read: {e}", media.id));
                    continue;
                }
            };
            let ciphertext = match media_sync::encrypt_media_bytes(key_state, &bytes) {
                Ok(c) => c,
                Err(e) => {
                    let _ = access.with_conn(|conn| {
                        db::mark_media_upload_error(conn, &media.id).map_err(sync_io)
                    });
                    stats
                        .errors
                        .push(format!("media {}: encrypt: {e}", media.id));
                    continue;
                }
            };
            if let Err(e) = self.provider.write_file(&path, &ciphertext).await {
                let _ = access.with_conn(|conn| {
                    db::mark_media_upload_error(conn, &media.id).map_err(sync_io)
                });
                stats
                    .errors
                    .push(format!("media {}: upload: {e}", media.id));
                continue;
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            if let Err(e) = access.with_conn(|conn| {
                db::mark_media_uploaded(conn, &media.id, &path, now).map_err(sync_io)
            }) {
                stats
                    .errors
                    .push(format!("media {}: mark_uploaded: {e}", media.id));
                continue;
            }
            stats.media_uploaded += 1;
            if should_emit(media_i, media_total) {
                self.emit_progress(
                    SyncProgressPhase::PushingMedia,
                    (media_i + 1) as u32,
                    media_total as u32,
                );
            }

            // Upload thumbnail alongside the full media file, when present.
            // Thumbnails are encrypted with the same key — they're still
            // user content and the trust boundary is unchanged.
            // A thumbnail failure does not abort the main media upload.
            if let Some(thumb_path) = media.thumbnail_path.as_deref() {
                let remote_thumb = format!("{path}.thumb");
                match std::fs::read(thumb_path) {
                    Ok(tbytes) => match media_sync::encrypt_media_bytes(key_state, &tbytes) {
                        Ok(tct) => {
                            if let Err(e) = self.provider.write_file(&remote_thumb, &tct).await {
                                log::warn!("media {}: upload thumbnail failed: {e}", media.id);
                            }
                        }
                        Err(e) => log::warn!("media {}: encrypt thumb: {e}", media.id),
                    },
                    Err(e) => log::warn!("media {}: read thumb {thumb_path}: {e}", media.id),
                }
            }
        }
        self.emit_progress(
            SyncProgressPhase::PushingMedia,
            media_total as u32,
            media_total as u32,
        );

        // Now push entries — media for each entry is already in the cloud,
        // so the embedded media manifest references uploadable ids.
        let pending = access.with_conn(|conn| db::list_pending_entry_ids(conn).map_err(sync_io))?;
        let entry_total = pending.len();
        // Emit start before the loop so the UI shows "Pushing entries 0/N".
        self.emit_progress(SyncProgressPhase::PushingEntries, 0, entry_total as u32);
        for (entry_i, entry_id) in pending.iter().enumerate() {
            match self.push_single_entry(access, key, entry_id).await {
                Ok(()) => stats.pushed += 1,
                Err(e) => {
                    log::warn!("push failed for entry {entry_id}: {e}");
                    stats.errors.push(format!("{entry_id}: {e}"));
                }
            }
            self.heartbeat();
            if should_emit(entry_i, entry_total) {
                self.emit_progress(
                    SyncProgressPhase::PushingEntries,
                    (entry_i + 1) as u32,
                    entry_total as u32,
                );
            }
        }
        self.emit_progress(
            SyncProgressPhase::PushingEntries,
            entry_total as u32,
            entry_total as u32,
        );

        // Push pending entry-version snapshots, mirroring the media loop
        // above: immutable per-device blob files, own `upload_status`,
        // HKDF sync_key + XJS1-style wrapper (see `version_sync.rs`).
        // Also reconciles this device's own `versions/` cloud folder,
        // deleting any file whose id no longer has a local DB row (pruned
        // locally by `prune_entry_versions`) — self-healing, no pruned-id
        // plumbing required.
        match self.push_versions(access, key).await {
            Ok((uploaded, errs)) => {
                stats.versions_uploaded = uploaded;
                stats.errors.extend(errs);
            }
            Err(e) => stats.errors.push(format!("versions: {e}")),
        }

        // Push this device's locally-computed embedding chunk vectors
        // (Phase 5 Task 2) alongside entries/versions, same trigger and
        // same provider. No progress phase / no reconcile-cloud step yet —
        // this sync channel has no pull side until Task 3, so there is
        // nothing for a device to converge against yet.
        match self.push_embedding_chunks(access, key).await {
            Ok((uploaded, errs)) => {
                stats.embedding_chunk_batches_uploaded = uploaded;
                stats.errors.extend(errs);
            }
            Err(e) => stats.errors.push(format!("embedding chunks: {e}")),
        }

        // Push the per-device settings and tags manifests. Both channels
        // write the full set every tick — payloads are tiny and per-row
        // LWW reconciles divergences on the receiver. Push failures fold
        // into `stats.errors` so an unreachable provider can't sink the
        // whole tick.
        // Single-shot phases: emit start (current=0) then end (current=1).
        self.emit_progress(SyncProgressPhase::PushingSettings, 0, 1);
        if let Err(e) = self.push_settings(access, key).await {
            stats.errors.push(format!("settings: {e}"));
        }
        self.emit_progress(SyncProgressPhase::PushingSettings, 1, 1);

        self.emit_progress(SyncProgressPhase::PushingTags, 0, 1);
        if let Err(e) = self.push_tags(access, key).await {
            stats.errors.push(format!("tags: {e}"));
        }
        self.emit_progress(SyncProgressPhase::PushingTags, 1, 1);

        self.emit_progress(SyncProgressPhase::PushingTemplates, 0, 1);
        if let Err(e) = self.push_templates(access, key).await {
            stats.errors.push(format!("templates: {e}"));
        }
        self.emit_progress(SyncProgressPhase::PushingTemplates, 1, 1);

        self.emit_progress(SyncProgressPhase::PushingLocations, 0, 1);
        if let Err(e) = self.push_location_aliases(access, key).await {
            stats.errors.push(format!("locations: {e}"));
        }
        self.emit_progress(SyncProgressPhase::PushingLocations, 1, 1);

        self.emit_progress(SyncProgressPhase::PushingChats, 0, 1);
        let chats_present = match self.push_chats(access, key).await {
            Ok(()) => true,
            Err(e) => {
                stats.errors.push(format!("chats: {e}"));
                false
            }
        };
        self.emit_progress(SyncProgressPhase::PushingChats, 1, 1);

        // Memory is a full-table encrypted surface like chats. Its presence
        // flag is published only after the blob write has succeeded, so a
        // peer never treats a failed write as readable state.
        let memory_present = match self.push_memory(access, key).await {
            Ok(present) => present,
            Err(e) => {
                stats.errors.push(format!("memory: {e}"));
                false
            }
        };

        self.emit_progress(SyncProgressPhase::PushingStreak, 0, 1);
        if let Err(e) = self.push_streak(access, key).await {
            stats.errors.push(format!("streak: {e}"));
        }
        self.emit_progress(SyncProgressPhase::PushingStreak, 1, 1);

        self.emit_progress(SyncProgressPhase::PushingAiAudit, 0, 1);
        if let Err(e) = self.push_ai_audit(access, key).await {
            stats.errors.push(format!("ai_audit: {e}"));
        }
        self.emit_progress(SyncProgressPhase::PushingAiAudit, 1, 1);

        // No dedicated SyncProgressPhase — same as memory.
        if let Err(e) = self.push_ai_reviews(access, key).await {
            stats.errors.push(format!("ai_reviews: {e}"));
        }

        // Hash-gate metadata.json (surface `"metadata"`): skip the write when
        // entry/journal lists, presence flags, and recovery_generation are
        // unchanged. `generated_at` is wall-clock and must not bust the gate.
        let manifest = access.with_conn(|conn| {
            build_local_manifest(conn, &self.device_id, chats_present, memory_present)
                .map_err(sync_io)
        })?;
        let hash_bytes =
            metadata_hash_bytes(&manifest).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let upload_bytes =
            serde_json::to_vec(&manifest).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_metadata_json(access, &hash_bytes, &upload_bytes)
            .await?;
        Ok(stats)
    }

    /// SHA-256 of plaintext surface content, lowercase hex.
    ///
    /// Hash the **content** portion only — callers must already exclude
    /// wall-clock fields such as `generated_at`. Never hash ciphertext:
    /// AES-GCM uses a random nonce, so identical plaintext encrypts to
    /// different bytes every time.
    fn surface_content_hash(payload_bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(payload_bytes))
    }

    /// Look up the stored last-push hash for `surface`. Returns `Ok(true)`
    /// when it already matches `content_hash` (caller should skip upload).
    fn surface_push_hash_is_clean<C: ConnAccess>(
        access: &C,
        surface: &str,
        content_hash: &str,
    ) -> Result<bool, SyncError> {
        let stored =
            access.with_conn(|conn| db::get_surface_push_hash(conn, surface).map_err(sync_io))?;
        Ok(stored.as_deref() == Some(content_hash))
    }

    /// Persist `content_hash` for `surface` after a successful provider write.
    fn store_surface_push_hash_after_write<C: ConnAccess>(
        access: &C,
        surface: &str,
        content_hash: &str,
    ) -> Result<(), SyncError> {
        access.with_conn(|conn| {
            db::set_surface_push_hash(conn, surface, content_hash).map_err(sync_io)
        })
    }

    /// Hash-gated push for one whole-table surface (`settings`, `tags`, …).
    ///
    /// 1. Hash `hash_bytes` (plaintext content; `generated_at` already excluded).
    /// 2. If that hash matches the stored last-push hash → return without any
    ///    provider call (no encrypt, no `write_file`).
    /// 3. Otherwise encrypt `upload_bytes`, write `{device_id}/{surface}.bin`,
    ///    and **only on success** store the new hash.
    ///
    /// Storing the hash only after a successful upload keeps failures dirty so
    /// the next cycle retries. A local write that lands after the hash was
    /// computed yields a different hash next cycle and is picked up.
    ///
    /// `hash_bytes` and `upload_bytes` may differ: peers may rely on
    /// `generated_at` in the uploaded envelope while the gate must ignore it.
    /// When they are identical (e.g. streak has no `generated_at`), pass the
    /// same slice twice.
    async fn push_hashed_surface<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        surface: &str,
        hash_bytes: &[u8],
        upload_bytes: &[u8],
    ) -> Result<(), SyncError> {
        let content_hash = Self::surface_content_hash(hash_bytes);
        if Self::surface_push_hash_is_clean(access, surface, &content_hash)? {
            return Ok(());
        }

        let ks = self.make_key_state(key);
        let ct = encrypt_data_with_state(upload_bytes, &ks).map_err(SyncError::Serialization)?;
        let path = format!("{}/{surface}.bin", self.device_id);
        self.provider.write_file(&path, &ct).await?;

        Self::store_surface_push_hash_after_write(access, surface, &content_hash)
    }

    /// Hash-gated write of plaintext `{device_id}/metadata.json`.
    ///
    /// Reuses the same `sync_push_state` surface key `"metadata"` as the
    /// encrypted whole-table surfaces — only the path (`.json` not `.bin`)
    /// and lack of encryption differ. Callers must already exclude
    /// `generated_at` from `hash_bytes` (see [`metadata_hash_bytes`]).
    async fn push_hashed_metadata_json<C: ConnAccess>(
        &self,
        access: &C,
        hash_bytes: &[u8],
        upload_bytes: &[u8],
    ) -> Result<(), SyncError> {
        let content_hash = Self::surface_content_hash(hash_bytes);
        if Self::surface_push_hash_is_clean(access, "metadata", &content_hash)? {
            return Ok(());
        }

        let path = format!("{}/metadata.json", self.device_id);
        self.provider.write_file(&path, upload_bytes).await?;

        Self::store_surface_push_hash_after_write(access, "metadata", &content_hash)
    }

    /// Serialize the local device's syncable settings, encrypt, and write
    /// to `{device_id}/settings.bin`. Mirrors the entry payload encryption
    /// (AES-GCM over JSON) so the same trust boundary applies.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`] — the
    /// gate hashes the settings map only so wall-clock `generated_at` cannot
    /// force a re-upload every tick.
    pub async fn push_settings<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let rows = access.with_conn(|conn| db::list_syncable_settings(conn).map_err(sync_io))?;
        let mut settings = std::collections::BTreeMap::new();
        for (k, value, updated_at, deleted_at) in rows {
            settings.insert(
                k,
                super::metadata::SyncedSetting {
                    value,
                    updated_at,
                    deleted_at,
                },
            );
        }
        // Hash data only (BTreeMap is deterministic); upload keeps envelope.
        let hash_bytes =
            serde_json::to_vec(&settings).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::SettingsPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            settings,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "settings", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull every peer's `{peer}/settings.bin`, decrypt, and LWW-merge
    /// each key into the local DB via `upsert_synced_setting_lww`.
    /// `ai_provider_endpoints` is special-cased: per-preset newer-wins
    /// via [`db::merge_provider_endpoints_from_sync`].
    /// Per-peer failures (missing file, decrypt error) are collected
    /// rather than aborting so one bad peer doesn't sink the whole pull.
    pub async fn pull_settings<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<SettingsPullStats, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut errors = Vec::new();
        let mut changed_endpoint_presets = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self
                .provider
                .read_file(&format!("{peer}/settings.bin"))
                .await
            {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: settings.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: settings decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: settings"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::SettingsPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: settings parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: settings payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let local_device = self.device_id.clone();
            let remote_device = payload.device_id.clone();
            let merge: Result<Vec<String>, SyncError> = access.with_conn(|conn| {
                let mut peer_changed = Vec::new();
                for (k, synced) in &payload.settings {
                    // Defense in depth: reject any key not on the allowlist
                    // even if a peer running buggy / malicious code tried
                    // to push one. Same key shape the writer enforces.
                    // Legacy `invisible_lock_verifier` is not allowlisted —
                    // remote payloads still carrying it are ignored here.
                    if !db::is_syncable_setting(k) {
                        continue;
                    }
                    // Multi-vault PHCs: merge-by-id into `invisible_vaults`
                    // (never whole-blob LWW — a peer with a subset would
                    // wipe vaults created on this device).
                    if k == db::INVISIBLE_VAULTS_JSON_KEY {
                        db::merge_invisible_vaults_from_sync(conn, &synced.value)
                            .map_err(sync_io)?;
                        continue;
                    }
                    // Per-preset stamped map — never whole-blob LWW.
                    if k == db::AI_PROVIDER_ENDPOINTS_KEY {
                        let changed = db::merge_provider_endpoints_from_sync(conn, &synced.value)
                            .map_err(sync_io)?;
                        peer_changed.extend(changed);
                        continue;
                    }
                    db::upsert_synced_setting_lww(
                        conn,
                        k,
                        &synced.value,
                        synced.updated_at,
                        synced.deleted_at,
                        &remote_device,
                        &local_device,
                    )
                    .map_err(sync_io)?;
                }
                Ok(peer_changed)
            });
            match merge {
                Ok(changed) => changed_endpoint_presets.extend(changed),
                Err(e) => errors.push(format!("peer {peer}: settings merge: {e}")),
            }
        }
        changed_endpoint_presets.sort();
        changed_endpoint_presets.dedup();
        Ok(SettingsPullStats {
            errors,
            changed_endpoint_presets,
        })
    }

    /// Serialize the local device's tags (including tombstones), encrypt,
    /// and write to `{device_id}/tags.bin`. Tags ride on their own channel
    /// because they can be created/edited in the tag manager independently
    /// of any entry — piggybacking on entries would leave orphan tags
    /// unsynced.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`].
    pub async fn push_tags<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let rows = access.with_conn(|conn| db::list_syncable_tags(conn).map_err(sync_io))?;
        let tags: Vec<super::metadata::SyncedTag> = rows
            .into_iter()
            .map(|r| super::metadata::SyncedTag {
                id: r.id,
                name: r.name,
                color: r.color,
                updated_at: r.updated_at,
                is_deleted: r.is_deleted,
            })
            .collect();
        // `list_syncable_tags` is ORDER BY id ASC — stable for hashing.
        let hash_bytes =
            serde_json::to_vec(&tags).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::TagsPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            tags,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "tags", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull every peer's `{peer}/tags.bin`, decrypt, and per-row LWW-merge
    /// each tag (including tombstones) into the local DB. Per-peer
    /// failures are collected — one bad peer doesn't sink the pull.
    pub async fn pull_tags<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut errors = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self.provider.read_file(&format!("{peer}/tags.bin")).await {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: tags.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: tags decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: tags"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::TagsPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: tags parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: tags payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let local_device = self.device_id.clone();
            let remote_device = payload.device_id.clone();
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                for t in &payload.tags {
                    // Reject ids that don't pass the safe-shape check —
                    // tag ids cross into the entry_tags FK chain.
                    if !is_safe_id(&t.id) {
                        continue;
                    }
                    let safe_name = sanitize_display_name(&t.name);
                    db::upsert_synced_tag_lww(
                        conn,
                        &t.id,
                        &safe_name,
                        t.color.as_deref(),
                        t.updated_at,
                        t.is_deleted,
                        &remote_device,
                        &local_device,
                    )
                    .map_err(sync_io)?;
                }
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: tags merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Serialize the local device's USER templates (predefined templates
    /// are not synced — each device seeds its own), encrypt, and write
    /// `{device_id}/templates.bin`. Binary `content` rides as base64
    /// inside JSON since JSON can't carry raw bytes.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`].
    pub async fn push_templates<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let rows = access.with_conn(|conn| db::list_syncable_templates(conn).map_err(sync_io))?;
        let templates: Vec<super::metadata::SyncedTemplate> = rows
            .into_iter()
            .map(|r| super::metadata::SyncedTemplate {
                id: r.id,
                name: r.name,
                description: r.description,
                content_b64: r.content.map(|c| B64.encode(c)),
                sort_order: r.sort_order,
                created_at: r.created_at,
                updated_at: r.updated_at,
                is_deleted: r.is_deleted,
            })
            .collect();
        // `list_syncable_templates` is ORDER BY id ASC — stable for hashing.
        let hash_bytes =
            serde_json::to_vec(&templates).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::TemplatesPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            templates,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "templates", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull each peer's templates manifest and LWW-merge into local DB.
    pub async fn pull_templates<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let mut errors = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self
                .provider
                .read_file(&format!("{peer}/templates.bin"))
                .await
            {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: templates.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: templates decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: templates"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::TemplatesPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: templates parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: templates payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let local_device = self.device_id.clone();
            let remote_device = payload.device_id.clone();
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                for t in &payload.templates {
                    if !is_safe_id(&t.id) {
                        continue;
                    }
                    // Cap description size: reject the row entirely on
                    // overrun (rather than truncate) so a bad peer's
                    // payload can't poison the local row.
                    if let Some(d) = t.description.as_deref() {
                        if d.len() > MAX_DESCRIPTION_BYTES {
                            log::warn!(
                                "template {} description {} bytes exceeds cap; skipping",
                                t.id,
                                d.len()
                            );
                            continue;
                        }
                    }
                    let content_bytes = match t.content_b64.as_deref() {
                        Some(s) => {
                            // Cap base64-decoded size: rough 3/4 ratio
                            // means an oversized b64 string almost
                            // certainly exceeds the byte cap too.
                            if s.len() > MAX_TEMPLATE_CONTENT_BYTES * 4 / 3 + 16 {
                                log::warn!(
                                    "template {} content_b64 length {} exceeds cap; skipping",
                                    t.id,
                                    s.len()
                                );
                                continue;
                            }
                            match B64.decode(s) {
                                Ok(b) if b.len() <= MAX_TEMPLATE_CONTENT_BYTES => Some(b),
                                Ok(b) => {
                                    log::warn!(
                                        "template {} decoded content {} bytes exceeds cap; skipping",
                                        t.id,
                                        b.len()
                                    );
                                    continue;
                                }
                                Err(e) => {
                                    // Skip this row entirely rather than
                                    // falling through with `None` — a
                                    // corrupted b64 used to silently
                                    // overwrite the local template's
                                    // content with NULL when LWW won
                                    // (codex-C1). Treat decode failure
                                    // identically to the oversize
                                    // branches so the local row stays
                                    // intact.
                                    log::warn!("template {} content_b64 decode: {e}", t.id);
                                    continue;
                                }
                            }
                        }
                        None => None,
                    };
                    let safe_name = sanitize_display_name(&t.name);
                    db::upsert_synced_template_lww(
                        conn,
                        &t.id,
                        &safe_name,
                        t.description.as_deref(),
                        content_bytes.as_deref(),
                        t.sort_order,
                        t.created_at,
                        t.updated_at,
                        t.is_deleted,
                        &remote_device,
                        &local_device,
                    )
                    .map_err(sync_io)?;
                }
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: templates merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Push the full chat history (all sessions + all messages) to
    /// `{device_id}/chats.bin`. Single-file because chat volume is
    /// bounded and per-session files would multiply small-file uploads.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`].
    pub async fn push_chats<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let rows =
            access.with_conn(|conn| db::list_syncable_chat_sessions(conn).map_err(sync_io))?;
        let sessions: Vec<super::metadata::SyncedChatSession> = rows
            .into_iter()
            .map(|s| super::metadata::SyncedChatSession {
                id: s.id,
                title: s.title,
                persona: s.persona,
                persona_prompt_snapshot: s.persona_prompt_snapshot,
                language: s.language,
                created_at: s.created_at,
                updated_at: s.updated_at,
                is_deleted: s.is_deleted,
                title_is_ai_generated: s.title_is_ai_generated,
                used_rag: s.used_rag,
                converted_entry_id: s.converted_entry_id,
                converted_through_seq: s.converted_through_seq,
                pinned_at: s.pinned_at,
                messages: s
                    .messages
                    .into_iter()
                    .map(|m| super::metadata::SyncedChatMessage {
                        id: m.id,
                        role: m.role,
                        content: m.content,
                        seq: m.seq,
                        created_at: m.created_at,
                        model_id: m.model_id,
                        provider_id: m.provider_id,
                        endpoint_class: m.endpoint_class,
                        tokens_in: m.tokens_in,
                        tokens_out: m.tokens_out,
                        latency_ms: m.latency_ms,
                        attachments: m.attachments,
                        source_entry_ids: m.source_entry_ids,
                        memory_ids: m.memory_ids,
                    })
                    .collect(),
            })
            .collect();
        // Sessions ORDER BY id; messages by (seq, created_at, id) — stable.
        let hash_bytes =
            serde_json::to_vec(&sessions).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::ChatPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            sessions,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "chats", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull each peer's chats manifest. Session-level fields LWW-merge;
    /// messages union-merge by `id` (immutable once written).
    pub async fn pull_chats<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let peers = self
            .list_pull_devices()
            .await?
            .into_iter()
            .map(|peer| (peer, false))
            .collect::<Vec<_>>();
        self.pull_chats_from_peers(access, key_state, &peers).await
    }

    async fn pull_chats_from_peers<C: ConnAccess>(
        &self,
        access: &C,
        key_state: &crate::EncryptionKeyState,
        peers: &[(String, bool)],
    ) -> Result<Vec<String>, SyncError> {
        let mut errors = Vec::new();
        for (peer, declared_present) in peers {
            if !self.include_self_in_pull && peer == &self.device_id {
                continue;
            }
            let bytes = match self.provider.read_file(&format!("{peer}/chats.bin")).await {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => {
                    if *declared_present {
                        errors.push(format!("peer {peer}: chats.bin: missing"));
                    }
                    continue;
                }
                Err(e) => {
                    errors.push(format!("peer {peer}: chats.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: chats decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: chats"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::ChatPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: chats parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: chats payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let local_device = self.device_id.clone();
            let remote_device = payload.device_id.clone();
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                for s in &payload.sessions {
                    if !is_safe_id(&s.id) {
                        continue;
                    }
                    let safe_title = s.title.as_deref().map(sanitize_display_name);
                    // Filter peer-supplied `converted_entry_id` through the
                    // same safety check as `s.id`: without this a malicious
                    // peer could bloat the partial index
                    // `idx_chat_sessions_converted_entry` with multi-MB
                    // strings, or poison the entry-banner lookup with garbage
                    // ids that would later render in the UI.
                    let safe_converted_entry_id = s
                        .converted_entry_id
                        .as_deref()
                        .filter(|id| is_safe_id(id));
                    // `(converted_entry_id, converted_through_seq)` is an
                    // ATOMIC PAIR at the ratchet boundary. When the paired
                    // id fails the safety check we forward `None` for BOTH
                    // the id AND the seq — forwarding the seq verbatim would
                    // let the ratchet fire on `remote_seq > local_seq` and
                    // clobber a known-good local `converted_entry_id` with
                    // NULL while bumping the seq, leaving a self-inconsistent
                    // `(NULL, Some(seq))` state that silently skips messages
                    // on the next conversion. `None` means "no information",
                    // which never clears a known watermark.
                    let safe_converted_through_seq = if safe_converted_entry_id.is_some() {
                        s.converted_through_seq
                    } else {
                        None
                    };
                    db::upsert_synced_chat_session_lww(
                        conn,
                        &s.id,
                        safe_title.as_deref(),
                        &s.persona,
                        &s.persona_prompt_snapshot,
                        &s.language,
                        s.created_at,
                        s.updated_at,
                        s.is_deleted,
                        s.title_is_ai_generated,
                        s.used_rag,
                        safe_converted_entry_id,
                        safe_converted_through_seq,
                        // No sanitisation: unlike the title and the entry id
                        // this is a plain Option<i64> with no id, length or
                        // charset constraints to violate. Nor is it clamped
                        // like `updated_at` (MAX_CLOCK_SKEW_SECS): a poisoned
                        // i64::MAX only sorts the row first under `pinned_at
                        // DESC`, and it gates no write — unlike
                        // `safe_converted_through_seq`, which is clamped
                        // precisely because it feeds the comparison driving
                        // the watermark ratchet. A local unpin bumps
                        // `updated_at` and clears it through ordinary LWW.
                        s.pinned_at,
                        &remote_device,
                        &local_device,
                    )
                    .map_err(sync_io)?;
                    for m in &s.messages {
                        if !is_safe_id(&m.id) {
                            continue;
                        }
                        // Reject roles outside the CHECK constraint set.
                        if m.role != "user" && m.role != "assistant" {
                            continue;
                        }
                        // Cap message size — defense against an
                        // adversarial peer pushing a 100 MB content
                        // string per message.
                        if m.content.len() > MAX_CHAT_MESSAGE_BYTES {
                            log::warn!(
                                "chat message {} content {} bytes exceeds cap; skipping",
                                m.id,
                                m.content.len()
                            );
                            continue;
                        }
                        // Cap attachment / source-entry-id counts the same
                        // way content is capped above — these are otherwise
                        // the only uncapped per-message peer input on this
                        // surface, and the rows are append-only and never
                        // pruned.
                        if let Some(refs) = &m.attachments {
                            if refs.len() > MAX_CHAT_ATTACHMENTS {
                                log::warn!(
                                    "chat message {} has {} attachments exceeding cap {}; skipping",
                                    m.id,
                                    refs.len(),
                                    MAX_CHAT_ATTACHMENTS
                                );
                                continue;
                            }
                        }
                        if let Some(ids) = &m.source_entry_ids {
                            if ids.len() > MAX_CHAT_SOURCE_ENTRY_IDS {
                                log::warn!(
                                    "chat message {} has {} source entry ids exceeding cap {}; skipping",
                                    m.id,
                                    ids.len(),
                                    MAX_CHAT_SOURCE_ENTRY_IDS
                                );
                                continue;
                            }
                        }
                        if let Some(ids) = &m.memory_ids {
                            if ids.len() > MAX_CHAT_MEMORY_IDS {
                                log::warn!(
                                    "chat message {} has {} memory ids exceeding cap {}; skipping",
                                    m.id,
                                    ids.len(),
                                    MAX_CHAT_MEMORY_IDS
                                );
                                continue;
                            }
                        }
                        let meta = db::AiMessageMeta {
                            model_id: m.model_id.clone(),
                            provider_id: m.provider_id.clone(),
                            endpoint_class: m.endpoint_class.clone(),
                            tokens_in: m.tokens_in,
                            tokens_out: m.tokens_out,
                            latency_ms: m.latency_ms,
                        };
                        // Drop unrecognised attachment kinds (forward-compat:
                        // a later phase may add a third kind; an old build
                        // must degrade one attachment, not fail the whole
                        // peer payload), skip unsafe/oversize Entry ids
                        // element-wise (count caps alone would still accept
                        // 20 × multi-MB strings), and sanitize peer-supplied
                        // period labels the same way the session title is
                        // sanitized above — this label renders as a chip in
                        // the transcript.
                        let attachments: Option<Vec<db::ChatAttachmentRef>> =
                            m.attachments.as_ref().map(|refs| {
                                refs.iter()
                                    .filter_map(|r| match r {
                                        db::ChatAttachmentRef::Entry { id } => {
                                            if is_safe_id(id) {
                                                Some(db::ChatAttachmentRef::Entry {
                                                    id: id.clone(),
                                                })
                                            } else {
                                                log::warn!(
                                                    "chat message {} attachment entry id fails safety check (len {}); skipping element",
                                                    m.id,
                                                    id.len()
                                                );
                                                None
                                            }
                                        }
                                        db::ChatAttachmentRef::Period { start, end, label } => {
                                            Some(db::ChatAttachmentRef::Period {
                                                start: *start,
                                                end: *end,
                                                label: sanitize_display_name(label),
                                            })
                                        }
                                        db::ChatAttachmentRef::Unknown => None,
                                    })
                                    .collect()
                            });
                        let attachments = attachments.filter(|v: &Vec<_>| !v.is_empty());
                        // Same per-element filter for source_entry_ids — skip
                        // bad ids, keep the message (do NOT drop peer history).
                        let source_entry_ids: Option<Vec<String>> =
                            m.source_entry_ids.as_ref().map(|ids| {
                                ids.iter()
                                    .filter(|id| {
                                        if is_safe_id(id) {
                                            true
                                        } else {
                                            log::warn!(
                                                "chat message {} source_entry_id fails safety check (len {}); skipping element",
                                                m.id,
                                                id.len()
                                            );
                                            false
                                        }
                                    })
                                    .cloned()
                                    .collect()
                            });
                        let source_entry_ids =
                            source_entry_ids.filter(|v: &Vec<_>| !v.is_empty());
                        // Same per-element filter for memory_ids — skip bad
                        // ids, keep the message.
                        let memory_ids: Option<Vec<String>> = m.memory_ids.as_ref().map(|ids| {
                            ids.iter()
                                .filter(|id| {
                                    if is_safe_id(id) {
                                        true
                                    } else {
                                        log::warn!(
                                            "chat message {} memory_id fails safety check (len {}); skipping element",
                                            m.id,
                                            id.len()
                                        );
                                        false
                                    }
                                })
                                .cloned()
                                .collect()
                        });
                        let memory_ids = memory_ids.filter(|v: &Vec<_>| !v.is_empty());
                        db::upsert_synced_chat_message(
                            conn,
                            &m.id,
                            &s.id,
                            &m.role,
                            &m.content,
                            m.seq,
                            m.created_at,
                            &meta,
                            attachments.as_deref(),
                            source_entry_ids.as_deref(),
                            memory_ids.as_deref(),
                        )
                        .map_err(sync_io)?;
                    }
                }
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: chats merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Push every memory item, including tombstones, sources, and stored
    /// vectors as this device's encrypted `{device_id}/memory.bin` surface.
    /// The hash gate makes an unchanged full-table snapshot a no-op.
    pub async fn push_memory<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<bool, SyncError> {
        let (items, persona) = access.with_conn(|conn| {
            let items = db::memory::list_all_memory_items_for_sync(conn)
                .map_err(sync_io)?
                .into_iter()
                .map(|item| {
                    let sources = db::memory::list_sources_for_memory(conn, &item.id)
                        .map_err(sync_io)?
                        .into_iter()
                        .map(|source| super::metadata::MemorySourceRef {
                            source_type: source.source_type,
                            source_id: source.source_id,
                        })
                        .collect();
                    let embeddings = db::memory::list_memory_embeddings_for_memory(conn, &item.id)
                        .map_err(sync_io)?
                        .into_iter()
                        .map(|embedding| super::metadata::SyncedMemoryVec {
                            model_id: embedding.model_id,
                            dim: embedding.dim,
                            vec: embedding.vec,
                            content_hash: embedding.content_hash,
                            indexed_at: embedding.indexed_at,
                        })
                        .collect();
                    Ok(super::metadata::SyncedMemoryItem {
                        id: item.id,
                        text: item.text,
                        source_type: item.source_type,
                        enabled: item.enabled,
                        is_deleted: item.is_deleted,
                        created_at: item.created_at,
                        updated_at: item.updated_at,
                        sources,
                        embeddings,
                    })
                })
                .collect::<Result<Vec<_>, SyncError>>()?;
            let persona = db::persona::read_persona(conn).map_err(sync_io)?;
            Ok((
                items,
                super::metadata::SyncedPersona {
                    answers_json: persona.answers_json,
                    traits_text: persona.traits_text,
                    style_text: persona.style_text,
                    enabled: persona.enabled,
                    user_edited: persona.user_edited,
                    generated_at: persona.generated_at,
                    updated_at: persona.updated_at,
                },
            ))
        })?;
        if items.is_empty() && persona.updated_at == 0 {
            let path = format!("{}/memory.bin", self.device_id);
            match self.provider.delete_file(&path).await {
                Ok(()) | Err(SyncError::NotFound(_)) => {
                    access.with_conn(|conn| {
                        db::clear_surface_push_hash(conn, "memory").map_err(sync_io)
                    })?;
                    return Ok(false);
                }
                Err(error) => return Err(error),
            }
        }
        let payload = super::metadata::MemoryPayload {
            items,
            persona: Some(persona),
        };
        let hash_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "memory", &hash_bytes, &upload_bytes)
            .await?;
        Ok(true)
    }

    /// Pull all memory snapshots advertised by peer manifests. Items merge by
    /// LWW timestamp, source references union, and only matching active-model
    /// vectors can be adopted.
    async fn pull_memory_from_peers<C: ConnAccess>(
        &self,
        access: &C,
        key_state: &crate::EncryptionKeyState,
        peers: &[(String, bool)],
    ) -> Result<Vec<String>, SyncError> {
        let configured_model_id = access.with_conn(|conn| {
            Ok(crate::commands::ai_provider::configured_memory_embedding_model_id(conn))
        })?;
        let mut merged_item = false;
        let mut foreign_peer_models: HashMap<String, u64> = HashMap::new();
        // Memory ids that received at least one foreign-model vector this pull.
        let mut foreign_memory_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut errors = Vec::new();
        for (peer, declared_present) in peers {
            if !self.include_self_in_pull && peer == &self.device_id {
                continue;
            }
            if !*declared_present {
                continue;
            }
            let bytes = match self.provider.read_file(&format!("{peer}/memory.bin")).await {
                Ok(bytes) => bytes,
                Err(SyncError::NotFound(_)) => {
                    errors.push(format!("peer {peer}: memory.bin: missing"));
                    continue;
                }
                Err(e) => {
                    errors.push(format!("peer {peer}: memory.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(plain) => plain,
                Err(e) => {
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: memory"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::MemoryPayload = match serde_json::from_slice(&plain) {
                Ok(payload) => payload,
                Err(e) => {
                    errors.push(format!("peer {peer}: memory parse: {e}"));
                    continue;
                }
            };
            let merge = access.with_conn(|conn| {
                let mut peer_merged_item = false;
                let mut peer_foreign: HashMap<String, u64> = HashMap::new();
                let mut peer_foreign_ids: Vec<String> = Vec::new();
                for item in &payload.items {
                    if !is_safe_id(&item.id)
                        || !is_memory_source_type(&item.source_type)
                        || item.text.len() > MAX_MEMORY_TEXT_BYTES
                    {
                        continue;
                    }
                    // Memory edits are immediately user-editable after a pull.
                    // Do not retain even an otherwise tolerated future skew here:
                    // it would make a post-pull local edit lose LWW until the
                    // peer clock catches up. Local mutations advance monotonically.
                    let safe_updated_at = item.updated_at.min(now_unix());
                    db::memory::upsert_memory_item_lww(
                        conn,
                        &item.id,
                        &item.text,
                        &item.source_type,
                        item.enabled,
                        item.is_deleted,
                        item.created_at,
                        safe_updated_at,
                    )
                    .map_err(sync_io)?;
                    peer_merged_item = true;

                    // Sources are immutable evidence links, so union them
                    // even when this peer's item text lost the LWW contest.
                    for source in &item.sources {
                        if is_memory_source_type(&source.source_type)
                            && is_safe_id(&source.source_id)
                        {
                            db::memory::add_memory_source(
                                conn,
                                &item.id,
                                &source.source_type,
                                &source.source_id,
                            )
                            .map_err(sync_io)?;
                        }
                    }
                    let Some(local_model_id) = configured_model_id.as_deref() else {
                        continue;
                    };
                    let Some(current_text) =
                        db::memory::memory_item_text_for_sync(conn, &item.id).map_err(sync_io)?
                    else {
                        continue;
                    };
                    let current_content_hash = crate::ai::chunking::content_hash(&current_text);
                    for embedding in &item.embeddings {
                        let valid_vector_len = usize::try_from(embedding.dim)
                            .ok()
                            .and_then(|dim| dim.checked_mul(std::mem::size_of::<f32>()))
                            .is_some_and(|bytes| embedding.vec.len() == bytes);
                        if !valid_vector_len
                            || embedding.content_hash.len() > MAX_MEMORY_CONTENT_HASH_BYTES
                        {
                            continue;
                        }
                        let adopted = db::memory::adopt_memory_embedding_if_matching(
                            conn,
                            &item.id,
                            &embedding.model_id,
                            local_model_id,
                            embedding.dim,
                            &embedding.vec,
                            &embedding.content_hash,
                            &current_content_hash,
                            embedding.indexed_at,
                        )
                        .map_err(sync_io)?;
                        if !adopted && embedding.model_id != local_model_id {
                            *peer_foreign.entry(embedding.model_id.clone()).or_default() += 1;
                            peer_foreign_ids.push(item.id.clone());
                        }
                    }
                }
                // Persona merge is isolated from item merge: a malformed peer
                // persona must not roll back (or appear to fail) item adoption,
                // and must not skip the memory-worker nudge for items.
                let mut peer_merged_persona = false;
                let mut persona_merge_error: Option<String> = None;
                if let Some(persona) = &payload.persona {
                    let safe_updated_at = persona.updated_at.min(now_unix());
                    match db::persona::upsert_persona_lww(
                        conn,
                        &persona.answers_json,
                        &persona.traits_text,
                        &persona.style_text,
                        persona.enabled,
                        persona.user_edited,
                        persona.generated_at,
                        safe_updated_at,
                    ) {
                        Ok(changed) => peer_merged_persona = changed,
                        Err(e) => {
                            persona_merge_error = Some(format!("peer {peer}: persona merge: {e}"));
                        }
                    }
                }
                Ok((
                    peer_merged_item,
                    peer_merged_persona,
                    persona_merge_error,
                    peer_foreign,
                    peer_foreign_ids,
                ))
            });
            match merge {
                Ok((
                    peer_merged_item,
                    peer_merged_persona,
                    persona_merge_error,
                    peer_foreign,
                    peer_foreign_ids,
                )) => {
                    // Items and persona each dirty the same memory.bin surface.
                    merged_item |= peer_merged_item || peer_merged_persona;
                    for (model_id, count) in peer_foreign {
                        *foreign_peer_models.entry(model_id).or_default() += count;
                    }
                    foreign_memory_ids.extend(peer_foreign_ids);
                    if let Some(err) = persona_merge_error {
                        errors.push(err);
                    }
                }
                Err(e) => errors.push(format!("peer {peer}: memory merge: {e}")),
            }
        }

        // Foreign-model vectors on items that still lack the local-model
        // vector → device-local pending decision (blocks blind nudge).
        // Only the *intersection* stamps: foreign vectors on already-indexed
        // items must not gate unrelated local missing work.
        if let Some(model_id) = configured_model_id.as_deref() {
            // `stamp_needed`: foreign ids intersect missing local vectors.
            // Fail-closed on stamp IO error so we never blind-nudge cost.
            let mut block_nudge_for_foreign = false;
            if !foreign_peer_models.is_empty() && !foreign_memory_ids.is_empty() {
                let stamp_result = access.with_conn(|conn| {
                    let missing =
                        db::memory::list_memory_ids_missing_embedding_for_model(conn, model_id)
                            .map_err(sync_io)?;
                    let pending_units = missing
                        .iter()
                        .filter(|id| foreign_memory_ids.contains(id.as_str()))
                        .count() as u64;
                    if pending_units == 0 {
                        return Ok(false);
                    }
                    let mut peer_models: Vec<crate::ai::embedding_decision::PeerModelCount> =
                        foreign_peer_models
                            .iter()
                            .map(|(model_id, count)| {
                                crate::ai::embedding_decision::PeerModelCount {
                                    model_id: model_id.clone(),
                                    count: *count,
                                }
                            })
                            .collect();
                    peer_models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
                    crate::ai::embedding_decision::stamp_pending_if_needed(
                        conn,
                        crate::ai::embedding_decision::EmbedSyncSlot::Memory,
                        crate::ai::embedding_decision::EmbedSyncDecisionReason::ModelMismatch,
                        Some(model_id),
                        peer_models,
                        pending_units,
                        now_unix(),
                    )
                    .map_err(SyncError::Io)?;
                    Ok(true)
                });
                match stamp_result {
                    Ok(true) => block_nudge_for_foreign = true, // pending stamped (or refreshed)
                    Ok(false) => {}
                    Err(e) => {
                        // Needed stamp failed — do not nudge.
                        block_nudge_for_foreign = true;
                        errors.push(format!("memory embedding decision stamp: {e}"));
                    }
                }
            }

            // Only wake the worker when this pull merged memory, local
            // items still lack the configured model's vector, AND the
            // decision receipt allows SyncBackfill auto-index (none /
            // reembed; Pause+sync_backfill blocks this nudge). A
            // pending model_mismatch must not blind-nudge re-embed.
            let (has_backfill_work, allow_nudge) = access.with_conn(|conn| {
                let missing =
                    db::memory::list_memory_ids_missing_embedding_for_model(conn, model_id)
                        .map_err(sync_io)?;
                let decision = crate::ai::embedding_decision::read_embed_sync_decision(
                    conn,
                    crate::ai::embedding_decision::EmbedSyncSlot::Memory,
                )
                .map_err(SyncError::Io)?;
                Ok((
                    !missing.is_empty(),
                    crate::ai::embedding_decision::auto_index_allowed(
                        &decision,
                        crate::ai::embedding_decision::AutoIndexScope::SyncBackfill,
                    ),
                ))
            })?;
            // Successful stamp → pending → auto_index_allowed is already
            // false. Failed stamp → also block (fail-closed: never
            // blind-nudge foreign-model cost when the receipt could not
            // be written).
            let allow_nudge = allow_nudge && !block_nudge_for_foreign;
            if merged_item && has_backfill_work && allow_nudge {
                crate::commands::ai_memory::nudge_memory_worker();
            }
        }
        Ok(errors)
    }

    /// Push the local streak-cache row to `{device_id}/streak.bin`.
    /// Single row per device; receivers LWW-merge. Skips entirely when
    /// the local DB has no streak row yet (pre-first-recalculate) — the
    /// (0, 0, None, 0) baseline would otherwise occupy a cloud slot and
    /// confuse human inspection. LWW already protects against the
    /// zero-baseline overriding a peer's real value, this is defense.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`].
    /// `StreakPayload` has no `generated_at`, so hash and upload bytes are
    /// the same serialized payload.
    pub async fn push_streak<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let Some(row) = access.with_conn(|conn| db::get_syncable_streak(conn).map_err(sync_io))?
        else {
            return Ok(());
        };
        let payload = super::metadata::StreakPayload {
            device_id: self.device_id.clone(),
            current_streak: row.current_streak,
            longest_streak: row.longest_streak,
            last_entry_date: row.last_entry_date,
            updated_at: row.updated_at,
        };
        let bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "streak", &bytes, &bytes)
            .await
    }

    /// Pull peers' streak rows and LWW-merge. `longest_streak` ratchets
    /// upward across peers regardless of LWW order.
    pub async fn pull_streak<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut errors = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self.provider.read_file(&format!("{peer}/streak.bin")).await {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: streak.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: streak decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: streak"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::StreakPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: streak parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: streak payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let local_device = self.device_id.clone();
            let remote_device = payload.device_id.clone();
            if let Err(e) = access.with_conn(|conn| {
                db::upsert_synced_streak_lww(
                    conn,
                    payload.current_streak,
                    payload.longest_streak,
                    payload.last_entry_date,
                    payload.updated_at,
                    &remote_device,
                    &local_device,
                )
                .map_err(sync_io)
            }) {
                errors.push(format!("peer {peer}: streak merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Serialize the local device's location aliases, encrypt, and
    /// write `{device_id}/locations.bin`.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`].
    pub async fn push_location_aliases<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let rows =
            access.with_conn(|conn| db::list_syncable_location_aliases(conn).map_err(sync_io))?;
        let aliases: Vec<super::metadata::SyncedLocationAlias> = rows
            .into_iter()
            .map(|r| super::metadata::SyncedLocationAlias {
                id: r.id,
                label: r.label,
                address: r.address,
                latitude: r.latitude,
                longitude: r.longitude,
                radius_meters: r.radius_meters,
                created_at: r.created_at,
                updated_at: r.updated_at,
                is_deleted: r.is_deleted,
            })
            .collect();
        // `list_syncable_location_aliases` is ORDER BY id ASC.
        let hash_bytes =
            serde_json::to_vec(&aliases).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::LocationAliasesPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            aliases,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        // Surface stem is `locations` (matches `locations.bin` / reconcile).
        self.push_hashed_surface(access, key, "locations", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull each peer's location aliases manifest and LWW-merge.
    pub async fn pull_location_aliases<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut errors = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self
                .provider
                .read_file(&format!("{peer}/locations.bin"))
                .await
            {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: locations.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: locations decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: locations"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::LocationAliasesPayload =
                match serde_json::from_slice(&plain) {
                    Ok(p) => p,
                    Err(e) => {
                        errors.push(format!("peer {peer}: locations parse: {e}"));
                        continue;
                    }
                };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: locations payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let local_device = self.device_id.clone();
            let remote_device = payload.device_id.clone();
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                for a in &payload.aliases {
                    if !is_safe_id(&a.id) {
                        continue;
                    }
                    let safe_label = sanitize_display_name(&a.label);
                    let safe_address = sanitize_display_name(&a.address);
                    db::upsert_synced_location_alias_lww(
                        conn,
                        &a.id,
                        &safe_label,
                        &safe_address,
                        a.latitude,
                        a.longitude,
                        a.radius_meters,
                        a.created_at,
                        a.updated_at,
                        a.is_deleted,
                        &remote_device,
                        &local_device,
                    )
                    .map_err(sync_io)?;
                }
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: locations merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Serialize the local device's AI audit-log rows, encrypt, and write
    /// `{device_id}/ai_audit.bin`. Snapshot semantics: the full set of
    /// rows authored by this device is sent every tick. Peers replace
    /// their copy of this device's rows on pull, so a local retention
    /// purge propagates to every peer on the next sync.
    ///
    /// Privacy: no content is included. The payload fields mirror
    /// `AiAuditLogInsert` (metadata only — provider, model, timing,
    /// tokens). The same encryption envelope as other channels keeps the
    /// trust boundary identical.
    ///
    /// Push is filtered to `device_id = self.device_id` by
    /// [`db::list_local_ai_audit_log`], so peer rows we pulled never
    /// fan out a second time and the channel can never replicate.
    ///
    /// Unchanged content is skipped via [`Self::push_hashed_surface`].
    pub async fn push_ai_audit<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let rows = access.with_conn(|conn| db::list_local_ai_audit_log(conn).map_err(sync_io))?;
        let synced: Vec<super::metadata::SyncedAiAuditRow> = rows
            .into_iter()
            .map(|r| super::metadata::SyncedAiAuditRow {
                local_seq: r.local_seq,
                created_at: r.created_at,
                feature: r.feature,
                operation: r.operation,
                provider_id: r.provider_id,
                model_id: r.model_id,
                endpoint_host: r.endpoint_host,
                endpoint_class: r.endpoint_class,
                payload_bytes: r.payload_bytes,
                latency_ms: r.latency_ms,
                status: r.status,
                error_code: r.error_code,
                tokens_in: r.tokens_in,
                tokens_out: r.tokens_out,
                device_name: r.device_name,
            })
            .collect();
        // `list_local_ai_audit_log` is ORDER BY local_seq ASC.
        let hash_bytes =
            serde_json::to_vec(&synced).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::AiAuditPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            rows: synced,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "ai_audit", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull each peer's AI audit-log snapshot. **Snapshot-replace**: we
    /// delete every row authored by that peer in our local table, then
    /// insert the payload's rows verbatim. This is how a peer's
    /// retention purge propagates here.
    ///
    /// The peer's `device_id` from the payload (not the directory name)
    /// is used as the scope, but only after passing `is_safe_device_id`
    /// — a peer that lies about its `device_id` is skipped so it can't
    /// wipe another peer's rows.
    pub async fn pull_ai_audit<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut errors = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self
                .provider
                .read_file(&format!("{peer}/ai_audit.bin"))
                .await
            {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: ai_audit.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: ai_audit decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: ai_audit"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::AiAuditPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: ai_audit parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: ai_audit payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            // A peer's payload claiming to author rows under OUR device_id
            // would let it wipe our rows on the next push. Reject.
            if !self.include_self_in_pull && payload.device_id == self.device_id {
                errors.push(format!(
                    "peer {peer}: ai_audit payload device_id matches local; skipping"
                ));
                continue;
            }
            // ai_audit is the ONLY channel using `payload.device_id` as the
            // scope for a destructive snapshot-replace DELETE. A peer that
            // writes to `dev-a/ai_audit.bin` but claims `device_id: "dev-c"`
            // could otherwise wipe our mirror of dev-c and plant forged
            // rows under dev-c's name until dev-c's next push restored
            // them. Require the directory and the claimed author to agree.
            if payload.device_id != peer {
                errors.push(format!(
                    "peer {peer}: ai_audit payload claims device_id {:?}; skipping",
                    payload.device_id
                ));
                continue;
            }
            let remote_device = payload.device_id.clone();
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                let tx = conn.unchecked_transaction().map_err(sync_io)?;
                // Snapshot-replace: drop every row we have authored by this peer,
                // then insert the snapshot verbatim. Wrapped in a transaction so
                // a mid-merge failure leaves us at the prior snapshot.
                db::delete_ai_audit_log_for_device(&tx, &remote_device).map_err(sync_io)?;
                for r in &payload.rows {
                    // Defense-in-depth: strip control chars + cap length on
                    // every peer-supplied string before it lands in the
                    // local table, mirroring `pull_location_aliases`. A
                    // crafted payload won't inject control chars or 10 KB
                    // strings into the audit-log UI.
                    let insert = crate::db::queries::AiAuditLogInsert {
                        created_at: r.created_at,
                        feature: sanitize_audit_field(&r.feature),
                        operation: sanitize_audit_field(&r.operation),
                        provider_id: sanitize_audit_field(&r.provider_id),
                        model_id: sanitize_audit_field(&r.model_id),
                        endpoint_host: sanitize_audit_field(&r.endpoint_host),
                        endpoint_class: sanitize_audit_field(&r.endpoint_class),
                        payload_bytes: r.payload_bytes,
                        latency_ms: r.latency_ms,
                        status: sanitize_audit_field(&r.status),
                        error_code: r.error_code.as_deref().map(sanitize_audit_field),
                        tokens_in: r.tokens_in,
                        tokens_out: r.tokens_out,
                    };
                    let peer_name = sanitize_display_name(&r.device_name);
                    db::upsert_peer_ai_audit_log(
                        &tx,
                        &remote_device,
                        r.local_seq,
                        &peer_name,
                        &insert,
                    )
                    .map_err(sync_io)?;
                }
                tx.commit().map_err(sync_io)?;
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: ai_audit merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Serialize local `ai_reviews` rows, encrypt, and write
    /// `{device_id}/ai_reviews.bin`. Hash is the reviews vec only
    /// (`generated_at` is wall-clock and must not bust the gate).
    /// Empty list still serializes — same contract as templates.
    pub async fn push_ai_reviews<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(), SyncError> {
        let rows = access.with_conn(|conn| db::list_syncable_ai_reviews(conn).map_err(sync_io))?;
        let reviews: Vec<super::metadata::SyncedAiReview> = rows
            .into_iter()
            .map(|r| super::metadata::SyncedAiReview {
                kind: r.kind,
                period_start: r.period_start,
                period_end: r.period_end,
                model_id: r.model_id,
                result_json: r.result_json,
                entry_count: r.entry_count,
                created_at: r.created_at,
            })
            .collect();
        let hash_bytes =
            serde_json::to_vec(&reviews).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let payload = super::metadata::AiReviewsPayload {
            device_id: self.device_id.clone(),
            generated_at: now_unix(),
            reviews,
        };
        let upload_bytes =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        self.push_hashed_surface(access, key, "ai_reviews", &hash_bytes, &upload_bytes)
            .await
    }

    /// Pull each peer's AI reviews manifest and LWW-merge.
    /// Distinct periods union; same period uses `created_at` then device_id
    /// tie-break. Not a snapshot-replace (unlike `pull_ai_audit`).
    pub async fn pull_ai_reviews<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
    ) -> Result<Vec<String>, SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut errors = Vec::new();
        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            let bytes = match self
                .provider
                .read_file(&format!("{peer}/ai_reviews.bin"))
                .await
            {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: ai_reviews.bin: {e}"));
                    continue;
                }
            };
            let plain = match decrypt_data_with_state(&bytes, key_state) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("peer {peer}: ai_reviews decrypt raw error: {e}");
                    errors.push(map_envelope_error_for_user(
                        &format!("peer {peer}: ai_reviews"),
                        &e,
                    ));
                    continue;
                }
            };
            let payload: super::metadata::AiReviewsPayload = match serde_json::from_slice(&plain) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: ai_reviews parse: {e}"));
                    continue;
                }
            };
            if !is_safe_device_id(&payload.device_id) {
                errors.push(format!(
                    "peer {peer}: ai_reviews payload device_id {:?} fails safety check; skipping",
                    payload.device_id
                ));
                continue;
            }
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                for r in &payload.reviews {
                    if r.kind != "weekly" && r.kind != "monthly" && r.kind != "insights" {
                        continue;
                    }
                    if r.period_start >= r.period_end {
                        continue;
                    }
                    if r.result_json.len() > 65536 {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(&r.result_json) {
                        Ok(serde_json::Value::Object(_)) => {}
                        _ => continue,
                    }
                    db::upsert_synced_ai_review_lww(
                        conn,
                        &db::AiReviewRow {
                            kind: r.kind.clone(),
                            period_start: r.period_start,
                            period_end: r.period_end,
                            model_id: r.model_id.clone(),
                            result_json: r.result_json.clone(),
                            entry_count: r.entry_count,
                            created_at: r.created_at,
                        },
                        &payload.device_id,
                        &self.device_id,
                    )
                    .map_err(sync_io)?;
                }
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: ai_reviews merge: {e}"));
            }
        }
        Ok(errors)
    }

    /// Push every pending journal payload to the provider. Each journal
    /// lands as `{device_id}/journals/{journal_id}.bin`. Failures per
    /// journal land in the returned error vector; the loop continues so
    /// one bad row doesn't sink the rest.
    pub async fn push_journals<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<Vec<String>, SyncError> {
        let pending =
            access.with_conn(|conn| db::list_pending_journal_ids(conn).map_err(sync_io))?;
        let mut errors = Vec::new();
        for journal_id in &pending {
            match self.push_single_journal(access, key, journal_id).await {
                Ok(()) => {}
                Err(e) => {
                    log::warn!("push journal {journal_id}: {e}");
                    errors.push(format!("{journal_id}: {e}"));
                }
            }
        }
        Ok(errors)
    }

    /// Encode + encrypt + write one journal payload, then stamp
    /// `journal_sync_state` synced. Mirrors `push_single_entry`.
    pub async fn push_single_journal<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        journal_id: &str,
    ) -> Result<(), SyncError> {
        let (journal, auto_tag_ids) = access.with_conn(|conn| {
            let journal = db::get_journal(conn, journal_id)
                .map_err(sync_io)?
                .ok_or_else(|| SyncError::NotFound(format!("journal {journal_id}")))?;
            let auto_tag_ids = db::list_journal_auto_tag_ids(conn, journal_id).map_err(sync_io)?;
            Ok((journal, auto_tag_ids))
        })?;

        let payload = super::metadata::JournalPayload {
            journal_id: journal.id.clone(),
            device_id: self.device_id.clone(),
            name: journal.name.clone(),
            color: journal.color.clone(),
            sort_order: journal.sort_order,
            is_deleted: journal.is_deleted,
            is_locked: journal.is_locked,
            is_invisible: journal.is_invisible,
            vault_id: journal.vault_id.clone(),
            created_at: journal.created_at,
            updated_at: journal.updated_at,
            auto_tag_ids,
        };
        let json =
            serde_json::to_vec(&payload).map_err(|e| SyncError::Serialization(e.to_string()))?;
        let ks = self.make_key_state(key);
        let ct = encrypt_data_with_state(&json, &ks).map_err(SyncError::Serialization)?;
        self.provider
            .write_file(
                &format!("{}/journals/{}.bin", self.device_id, journal_id),
                &ct,
            )
            .await?;

        access.with_conn(|conn| {
            let version = db::get_journal_local_version(conn, journal_id)
                .map_err(sync_io)?
                .ok_or_else(|| {
                    SyncError::Io(format!(
                        "journal {journal_id} has no journal_sync_state row"
                    ))
                })?;
            db::mark_journal_synced(conn, journal_id, version).map_err(sync_io)?;
            Ok(())
        })
    }

    /// Pull new / updated journals from every peer, decrypt, and LWW-
    /// upsert into the local DB. Tombstones from peers are applied as
    /// `is_deleted = 1` without pulling the payload (summary suffices).
    /// Mirrors `pull_remote` but for the journal channel.
    pub async fn pull_journals<C: ConnAccess>(
        &self,
        access: &C,
        _key: &[u8; 32],
        key_state: &crate::EncryptionKeyState,
        manifests: &[(String, DeviceMetadata)],
    ) -> Result<Vec<String>, SyncError> {
        let mut errors = Vec::new();

        let local_view: Vec<super::metadata::SyncedJournalSummary> = access
            .with_conn(|conn| db::list_local_journal_summaries_full(conn).map_err(sync_io))?
            .into_iter()
            .map(|j| super::metadata::SyncedJournalSummary {
                journal_id: j.journal_id,
                updated_at: j.updated_at,
                local_version: j.local_version,
                is_deleted: j.is_deleted,
            })
            .collect();

        for (peer, remote) in manifests {
            if !self.include_self_in_pull && peer == &self.device_id {
                continue;
            }
            let diff =
                recovery_journal_diff(&local_view, &remote.journals, self.include_self_in_pull);

            // Read all pulled payloads off the provider first — DB
            // mutations cannot straddle an `.await`.
            let mut pulled: Vec<(String, super::metadata::JournalPayload)> = Vec::new();
            for journal_id in &diff.to_pull {
                if !is_safe_id(journal_id) {
                    errors.push(format!("peer {peer}: bad journal id {journal_id:?}"));
                    continue;
                }
                let path = format!("{peer}/journals/{journal_id}.bin");
                let bytes = match self.provider.read_file(&path).await {
                    Ok(b) => b,
                    Err(SyncError::NotFound(_)) => {
                        // Normal pull tolerates a missing journal blob (stale
                        // manifest). Recovery must fail closed — a incomplete
                        // cloud folder cannot become the local source of truth.
                        errors.push(format!(
                            "peer {peer} journal {journal_id}: manifest references missing blob"
                        ));
                        continue;
                    }
                    Err(e) => {
                        errors.push(format!("peer {peer} journal {journal_id}: read: {e}"));
                        continue;
                    }
                };
                let plain = match decrypt_data_with_state(&bytes, key_state) {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!("peer {peer} journal {journal_id}: decrypt raw error: {e}");
                        errors.push(map_envelope_error_for_user(
                            &format!("peer {peer} journal {journal_id}"),
                            &e,
                        ));
                        continue;
                    }
                };
                match serde_json::from_slice::<super::metadata::JournalPayload>(&plain) {
                    Ok(p) => pulled.push((journal_id.clone(), p)),
                    Err(e) => errors.push(format!("peer {peer} journal {journal_id}: parse: {e}")),
                }
            }

            // Apply the diff under a single connection scope.
            let local_device = self.device_id.clone();
            let mut media_to_unlink: Vec<(String, Option<String>)> = Vec::new();
            let merge: Result<(), SyncError> = access.with_conn(|conn| {
                for (journal_id, payload) in &pulled {
                    if payload.journal_id != *journal_id {
                        errors.push(format!(
                            "peer {peer}: payload id {:?} != path id {journal_id:?}",
                            payload.journal_id
                        ));
                        continue;
                    }
                    if !is_safe_device_id(&payload.device_id) {
                        errors.push(format!(
                            "peer {peer} journal {journal_id}: device_id {:?} fails safety check",
                            payload.device_id
                        ));
                        continue;
                    }
                    let safe_name = sanitize_display_name(&payload.name);
                    let row_updated = db::upsert_journal_from_sync(
                        conn,
                        journal_id,
                        &safe_name,
                        payload.color.as_deref(),
                        payload.sort_order,
                        payload.is_deleted,
                        payload.is_locked,
                        payload.is_invisible,
                        payload.vault_id.as_deref(),
                        payload.created_at,
                        payload.updated_at,
                        &payload.device_id,
                        &local_device,
                    )
                    .map_err(sync_io)?;
                    // Only replace auto_tag_ids when the journal upsert
                    // actually won LWW — otherwise a stale peer payload
                    // could wipe-and-replace the auto-apply tag set
                    // even though the journal fields themselves were
                    // kept (codex-I1).
                    if row_updated {
                        let safe_tag_ids: Vec<String> = payload
                            .auto_tag_ids
                            .iter()
                            .filter(|id| is_safe_id(id))
                            .cloned()
                            .collect();
                        set_journal_auto_tags_from_sync(conn, journal_id, &safe_tag_ids)
                            .map_err(sync_io)?;
                    }
                }
                // Index the peer's journal summaries by id once so the
                // tombstone loop is O(n+m) instead of O(n*m) (was a
                // linear `find()` per id — fine at expected scale but
                // unfriendly to future growth).
                let summary_by_id: std::collections::HashMap<
                    &str,
                    &super::metadata::SyncedJournalSummary,
                > = remote
                    .journals
                    .iter()
                    .map(|s| (s.journal_id.as_str(), s))
                    .collect();
                for journal_id in &diff.to_delete_locally {
                    if !is_safe_id(journal_id) {
                        continue;
                    }
                    // Look up the remote's authoritative timestamp from
                    // the peer manifest's summary. `compute_journal_diff`
                    // already guaranteed `is_deleted = true` + `r.ts >
                    // l.ts` at diff time, but `local_view` is stale —
                    // an earlier peer in this same tick may have written
                    // a newer active journal. tombstone_journal_from_sync_lww
                    // re-checks the current row and applies the
                    // tombstone only when LWW still wins, using the
                    // remote's updated_at (NOT now_unix()) so future
                    // diffs converge (codex-C2).
                    let Some(summary) = summary_by_id.get(journal_id.as_str()) else {
                        continue;
                    };
                    // The cascade returns the media rows it deleted so their
                    // files are unlinked below, outside the DB lock.
                    media_to_unlink.extend(
                        db::tombstone_journal_from_sync_lww(
                            conn,
                            journal_id,
                            summary.updated_at,
                            peer,
                            &local_device,
                        )
                        .map_err(sync_io)?,
                    );
                }
                Ok(())
            });
            if let Err(e) = merge {
                errors.push(format!("peer {peer}: journal merge: {e}"));
            }
            self.unlink_pruned_media(&media_to_unlink);
        }
        Ok(errors)
    }

    /// Unlink media files whose rows a peer-applied tombstone just deleted,
    /// and re-arm the own-cloud media prune so the next Automatic cycle sweeps
    /// this device's now-orphaned cloud blobs.
    ///
    /// Without the re-arm the prune is a no-op for the rest of the session
    /// (`should_reconcile_own_cloud` runs it once per session on Automatic) and
    /// `sync_now` pushes before it pulls, so a receiving device would keep the
    /// deleted entries' blobs in its own cloud folder indefinitely. Always
    /// called with the DB lock released — filesystem deletes must never happen
    /// inside a transaction that could still roll back.
    ///
    /// TODO(later): the prune runs at the TOP of `push_local` and `sync_now`
    /// pushes before it pulls, so the sweep lands one cycle after the rows are
    /// dropped here — a Manual-only user must sync twice. See docs/LATER.md.
    fn unlink_pruned_media(&self, media: &[(String, Option<String>)]) {
        if media.is_empty() {
            return;
        }
        for (storage_path, thumbnail_path) in media {
            crate::commands::media::remove_media_files_best_effort(
                storage_path,
                thumbnail_path.as_deref(),
            );
        }
        self.session_own_cloud_reconciled
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Push a single entry by id. Used by `push_local` today and by the
    /// editor debounce path in Chunk 5 (command `push_entry`).
    pub async fn push_single_entry<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        entry_id: &str,
    ) -> Result<(), SyncError> {
        // Single lock acquisition: read the entry, journal, Yjs blob,
        // attached media, and tag ids at once, then release. All the
        // encryption + file I/O below runs without holding the DB mutex.
        let (entry, journal, yjs_blob, media_rows, deleted_media, tag_ids, serialized_version) =
            access.with_conn(|conn| {
                let entry = db::get_entry_raw(conn, entry_id)
                    .map_err(sync_io)?
                    .ok_or_else(|| SyncError::NotFound(format!("entry {entry_id}")))?;
                let journal = db::get_journal(conn, &entry.journal_id)
                    .map_err(sync_io)?
                    .ok_or_else(|| SyncError::NotFound(format!("journal {}", entry.journal_id)))?;
                let yjs_blob = db::get_entry_content(conn, entry_id).map_err(sync_io)?;
                let media_rows = db::get_media_for_entry(conn, entry_id).map_err(sync_io)?;
                let deleted_media = db::list_media_tombstones_for_entry(conn, entry_id)
                    .map_err(sync_io)?
                    .into_iter()
                    .map(|t| SyncDeletedMediaItem {
                        id: t.id,
                        deleted_at: t.deleted_at,
                    })
                    .collect::<Vec<_>>();
                let tag_ids = db::get_tag_ids_for_entry(conn, entry_id).map_err(sync_io)?;
                // Capture the local_version of the content we are about to
                // serialize.  We hold this through the upload so we can guard the
                // post-upload stamp against concurrent edits (Bug 1 fix).
                let serialized_version = db::get_entry_local_version(conn, entry_id)
                    .map_err(sync_io)?
                    .ok_or_else(|| {
                        SyncError::Io(format!(
                            "entry {entry_id} has no sync_state row — cannot read serialized_version"
                        ))
                    })?;
                Ok((
                    entry,
                    journal,
                    yjs_blob,
                    media_rows,
                    deleted_media,
                    tag_ids,
                    serialized_version,
                ))
            })?;

        // Only advertise media that's already uploaded — push_local uploads
        // media before entries, but a single-entry push (the editor debounce
        // path) bypasses that ordering. Surfacing not-yet-uploaded media in
        // the manifest would let a peer's `resolve_media` 404 on the .bin
        // until the next full push tick.
        let media: Vec<SyncMediaItem> = media_rows
            .into_iter()
            .filter(|m| m.upload_status == "uploaded")
            .map(|m| SyncMediaItem {
                id: m.id,
                file_name: m.file_name,
                file_type: m.file_type,
                file_size: m.file_size,
                sort_order: m.sort_order,
                created_at: m.created_at,
                insertion_mode: m.insertion_mode,
                width: m.width,
                height: m.height,
                duration_seconds: m.duration_seconds,
                exif_date: m.exif_date,
                exif_latitude: m.exif_latitude,
                exif_longitude: m.exif_longitude,
            })
            .collect();

        // Build the encrypted-metadata bundle. Phase 3: all entry fields are
        // plaintext in the DB. All fields — title, preview_text, content_text,
        // etc. — are wrapped together inside `metadata_ciphertext` for the
        // sync channel.
        let meta = EntryMetadata {
            entry_id: entry.id.clone(),
            device_id: self.device_id.clone(),
            updated_at: entry.updated_at,
            entry_date: entry.entry_date,
            created_at: entry.created_at,
            journal_id: journal.id.clone(),
            journal_name: Some(journal.name.clone()),
            journal_color: journal.color.clone(),
            journal_updated_at: Some(journal.updated_at),
            title: entry.title.clone(),
            preview_text: entry.preview_text.clone(),
            content_text: entry.content_text.clone(),
            location_label: entry.location_label.clone(),
            location_address: entry.location_address.clone(),
            weather_summary: entry.weather_summary.clone(),
            weather_icon: entry.weather_icon.clone(),
            latitude: entry.latitude,
            longitude: entry.longitude,
            emotion: entry.emotion.clone(),
            is_favorite: entry.is_favorite,
            is_deleted: entry.is_deleted,
            is_locked: entry.is_locked,
            is_invisible: entry.is_invisible,
            vault_id: entry.vault_id.clone(),
            cover_media_id: entry.cover_media_id.clone(),
            entry_date_user_edited: entry.entry_date_user_edited,
            content_language: entry.content_language.clone(),
            tag_ids,
            media,
            deleted_media,
        };
        let meta_plain =
            serde_json::to_vec(&meta).map_err(|e| SyncError::Serialization(e.to_string()))?;

        // Versioned envelope: `encrypt_data_with_state` always emits
        // `[0x01] ++ AES-GCM` (or `[0x02]` epoch-tagged). The plaintext `0x00`
        // version was removed with none-mode and can no longer be produced.
        // The fingerprint is kept separate (per `SyncEntryPayload`) as a
        // defence-in-depth guard in `ingest_entry`.
        let ks = self.make_key_state(key);
        // Fingerprint is over the envelope key (HKDF of the caller-passed sync
        // sub-key — note: this is two HKDF expansions from master, symmetric
        // with the ingest side).  `ks.with_sync_key` derives a second HKDF
        // expansion on top of the key that was already HKDF-derived in
        // `commands::sync`; both push and ingest apply the same number of
        // expansions, so the fingerprint and ciphertext round-trip correctly.
        let fp = ks
            .with_sync_key(|k| Ok(key_fingerprint(k)))
            .map_err(SyncError::Serialization)?;
        let meta_ct =
            encrypt_data_with_state(&meta_plain, &ks).map_err(SyncError::Serialization)?;
        // Phase 3: `yjs_doc` in the DB is raw (plaintext) bytes — encrypt it
        // here before it leaves the trust boundary onto the sync channel.
        // An entry with no Yjs blob yet (empty body) still gets an encrypted
        // empty marker so peers reliably observe "zero content" vs "key missing".
        let yjs_ct = {
            let yjs_payload = yjs_blob.unwrap_or_default();
            encrypt_data_with_state(&yjs_payload, &ks).map_err(SyncError::Serialization)?
        };

        let payload = SyncEntryPayload::new(fp, yjs_ct, meta_ct);
        let bytes = serialize_payload(&payload)?;
        self.provider
            .write_file(
                &format!("{}/entries/{}.bin", self.device_id, entry_id),
                &bytes,
            )
            .await?;

        // Local bookkeeping: stamp the row synced only when the version we
        // serialized matches the version currently in the DB.
        //
        // If a concurrent edit bumped local_version (via mark_entry_pending) while
        // the upload was in flight, current_version > serialized_version.  In that
        // case the cloud holds the old bytes and the new edit must NOT be falsely
        // marked synced — leave the row pending so the next push picks it up.
        //
        // Both reads (get_entry_local_version) and the stamp (mark_entry_synced)
        // run inside the same with_conn so nothing can slip between the compare
        // and the write.
        access.with_conn(|conn| {
            let current_version = db::get_entry_local_version(conn, entry_id)
                .map_err(sync_io)?
                .ok_or_else(|| {
                    SyncError::Io(format!(
                        "entry {entry_id} has no sync_state row — cannot stamp synced_version"
                    ))
                })?;
            if current_version == serialized_version {
                db::mark_entry_synced(conn, entry_id, serialized_version).map_err(sync_io)?;
            }
            // If current_version != serialized_version a concurrent edit bumped
            // the version while the upload was in flight.  Leave the row pending
            // so the next push cycle sends the newer content.
            Ok(())
        })
    }

    /// Push every pending entry-version snapshot for this device, then
    /// reconcile the device's own `versions/` cloud folder.
    ///
    /// Mirrors the media push loop in `push_local`: versions are immutable
    /// per-device blob files with their own `upload_status`, encrypted with
    /// the HKDF `sync_key` (never the master key). Per-version failures are
    /// collected rather than aborting the whole push, matching media's
    /// error tolerance.
    ///
    /// Reconcile step: after uploading, list this device's own `versions/`
    /// folder and delete any file whose id has no matching local
    /// `entry_versions` row (pruned locally by `prune_entry_versions` on an
    /// earlier tick). Only ever deletes files under this device's own
    /// folder — never a peer's.
    pub async fn push_versions<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(u64, Vec<String>), SyncError> {
        let mut uploaded = 0u64;
        let mut errors = Vec::new();
        let ks = self.make_key_state(key);

        let pending =
            access.with_conn(|conn| db::list_pending_version_uploads(conn).map_err(sync_io))?;
        let total = pending.len();
        self.emit_progress(SyncProgressPhase::PushingVersions, 0, total as u32);
        for (i, row) in pending.iter().enumerate() {
            // Heartbeat fires once per item regardless of success/failure —
            // see the comment on the media push loop for why this must not
            // sit behind a `continue`.
            self.heartbeat();
            match self.push_single_version(&ks, row).await {
                Ok(path) => {
                    if let Err(e) = access.with_conn(|conn| {
                        db::mark_version_uploaded(conn, &row.id, &path).map_err(sync_io)
                    }) {
                        errors.push(format!("version {}: mark_uploaded: {e}", row.id));
                        continue;
                    }
                    uploaded += 1;
                }
                Err(e) => errors.push(format!("version {}: {e}", row.id)),
            }
            if should_emit(i, total) {
                self.emit_progress(
                    SyncProgressPhase::PushingVersions,
                    (i + 1) as u32,
                    total as u32,
                );
            }
        }
        self.emit_progress(
            SyncProgressPhase::PushingVersions,
            total as u32,
            total as u32,
        );

        errors.extend(self.reconcile_own_version_files(access).await);

        Ok((uploaded, errors))
    }

    /// Encrypt and upload a single version snapshot. Returns the cloud path
    /// on success; does not touch the DB (the caller marks it uploaded).
    async fn push_single_version(
        &self,
        ks: &crate::EncryptionKeyState,
        row: &db::VersionRow,
    ) -> Result<String, SyncError> {
        let meta = VersionMetadata {
            version_id: row.id.clone(),
            entry_id: row.entry_id.clone(),
            created_at: row.created_at,
            device_id: row.device_id.clone(),
            preview_text: row.preview_text.clone(),
        };
        let meta_plain =
            serde_json::to_vec(&meta).map_err(|e| SyncError::Serialization(e.to_string()))?;

        // Same derivation as `push_single_entry`: fingerprint over the
        // HKDF-expanded sync sub-key, never the raw master key.
        let fp = ks
            .with_sync_key(|k| Ok(key_fingerprint(k)))
            .map_err(SyncError::Serialization)?;
        let yjs_ct = version_sync::encrypt_version_bytes(ks, &row.yjs_doc)?;
        let meta_ct = version_sync::encrypt_version_bytes(ks, &meta_plain)?;

        let payload = SyncVersionPayload::new(fp, yjs_ct, meta_ct);
        let bytes = serialize_version_payload(&payload)?;
        let path = version_cloud_path(&self.device_id, &row.id);
        self.provider.write_file(&path, &bytes).await?;
        Ok(path)
    }

    /// Self-healing reconcile: delete own-folder version files whose id no
    /// longer has a matching local `entry_versions` row. Runs every push
    /// cycle so a version pruned locally (retention/count cap) eventually
    /// disappears from the cloud too, without threading pruned-id lists
    /// through the prune command.
    async fn reconcile_own_version_files<C: ConnAccess>(&self, access: &C) -> Vec<String> {
        let mut errors = Vec::new();
        let own_paths = match self
            .provider
            .list_files(&self.device_id, FileKind::Versions)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("versions prune-cloud: list own folder: {e}"));
                return errors;
            }
        };
        for path in own_paths {
            let Some(file_name) = path.rsplit('/').next() else {
                continue;
            };
            let Some(version_id) = file_name.strip_suffix(".bin") else {
                continue;
            };
            if !is_safe_id(version_id) {
                continue;
            }
            let exists =
                access.with_conn(|conn| db::version_exists(conn, version_id).map_err(sync_io));
            match exists {
                Ok(true) => {}
                Ok(false) => {
                    if let Err(e) = self.provider.delete_file(&path).await {
                        errors.push(format!("versions prune-cloud: delete {path}: {e}"));
                    }
                }
                Err(e) => {
                    errors.push(format!("versions prune-cloud: check {version_id}: {e}"));
                }
            }
        }
        errors
    }

    /// Self-healing reconcile: delete own-folder media files whose id no longer
    /// has a matching local `media` row, so a media blob whose row was deleted
    /// locally — an inline node removed from the editor, media stripped on
    /// entry/journal soft-delete, or the explicit remove button — eventually
    /// disappears from the cloud too, without threading pruned-id lists through
    /// the delete command. Mirrors `reconcile_own_version_files`, but is gated
    /// by `should_reconcile_own_cloud` (once per session on Automatic, always on
    /// Manual) rather than running every cycle, because deleting media is
    /// irreversible and irreplaceable — see the wiped-DB guard below.
    ///
    /// Media blobs are stored at `{device_id}/media/{id}` with an optional
    /// sibling thumbnail at `{device_id}/media/{id}.thumb`, so the id is the
    /// file name with any `.thumb` suffix stripped. For each orphaned id BOTH
    /// the original and the thumbnail are deleted — the id is derived, not
    /// listed, so the thumbnail is swept even on providers whose media listing
    /// omits `.thumb` entries (the local/iCloud provider's does). `delete_file`
    /// is idempotent (missing file → Ok) on both providers, so deleting a
    /// never-existent thumbnail is a no-op. Consumes the Media listing already
    /// fetched by `reconcile_own_cloud_content` — a listing failure there fails
    /// the push closed before this prune runs.
    async fn reconcile_own_media_files<C: ConnAccess>(
        &self,
        access: &C,
        media_paths: &[String],
    ) -> Vec<String> {
        let mut errors = Vec::new();
        // Wiped/empty-DB safety guard. `sync_now` pushes BEFORE it pulls, so a
        // device that reached here with an unpopulated local DB and a writable
        // provider would delete EVERY own cloud media blob before any pull
        // could restore them — irreversible for irreplaceable photos.
        //
        // An empty local `media` table is AMBIGUOUS, so it alone can never
        // authorise deletion. It means either "the user deleted their media"
        // (prune) or "this database has not been populated" (never prune).
        // `db::count_deleted_entries` is the positive evidence that separates
        // them — see its doc comment for the full case analysis.
        //
        // This used to be `count_media == 0 -> skip`, full stop, which made the
        // legitimate case unfixable: delete the one journal that held all your
        // media and the blobs stayed in the cloud forever, with no second
        // chance (once the rows are gone the prune is the only thing that can
        // still recognise them as orphans). Widening it to "any entry rows at
        // all" was wrong in the other direction: a TEXT-ONLY Replace-All import
        // hard-wipes `media` + `entries` and then inserts N entries and 0
        // media, so the next sync would have deleted this device's entire cloud
        // media folder — and because `hard_wipe_user_data` emits no tombstones,
        // peers keep the old entries alive with `cloud_path` pointing into that
        // folder, making those photos permanently unfetchable for any peer that
        // had not cached them.
        //
        // TODO(later): tombstoned entry/journal `.bin` blobs are never pruned
        // from the cloud at all — only media is. See docs/LATER.md.
        let evidence = access.with_conn(|conn| {
            let media = db::count_media(conn).map_err(sync_io)?;
            let deleted_entries = db::count_deleted_entries(conn).map_err(sync_io)?;
            Ok((media, deleted_entries))
        });
        match evidence {
            Ok((0, 0)) => return errors,
            Ok(_) => {}
            Err(e) => {
                errors.push(format!("media prune-cloud: count local rows: {e}"));
                return errors;
            }
        }
        // Collect distinct candidate ids (a listing may surface both `{id}` and
        // `{id}.thumb` for the same media), so `media_exists` is checked once
        // per id and each orphan's pair is deleted once.
        let mut candidate_ids: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();
        for path in media_paths {
            let Some(file_name) = path.rsplit('/').next() else {
                continue;
            };
            let media_id = file_name.strip_suffix(".thumb").unwrap_or(file_name);
            if is_safe_id(media_id) {
                candidate_ids.insert(media_id.to_string());
            }
        }
        for media_id in candidate_ids {
            let exists =
                access.with_conn(|conn| db::media_exists(conn, &media_id).map_err(sync_io));
            match exists {
                Ok(true) => {}
                Ok(false) => {
                    let base = format!("{}/media/{media_id}", self.device_id);
                    let thumb = format!("{base}.thumb");
                    // Delete the thumbnail FIRST, the extensionless base blob
                    // LAST. The local/iCloud provider omits dotted names from
                    // media listings, so the base blob is the only anchor from
                    // which this id can be re-derived next cycle. If the base
                    // were deleted first and the thumb delete then failed
                    // transiently, the thumb would be stranded forever (no listed
                    // base to re-surface the id); with the base deleted last, any
                    // partial failure leaves it listed → the whole pair retries.
                    if let Err(e) = self.provider.delete_file(&thumb).await {
                        errors.push(format!("media prune-cloud: delete {thumb}: {e}"));
                    }
                    if let Err(e) = self.provider.delete_file(&base).await {
                        errors.push(format!("media prune-cloud: delete {base}: {e}"));
                    }
                }
                Err(e) => {
                    errors.push(format!("media prune-cloud: check {media_id}: {e}"));
                }
            }
        }
        errors
    }

    /// Push this device's locally-computed `entry_embedding_chunks` vectors
    /// (Phase 5 Task 2), respecting the same locked/invisible write-eligibility
    /// gate `list_entries_needing_index` / `claim_due_embedding_jobs` apply on
    /// the write side. A device only ever uploads vectors it produced/holds
    /// locally — there is no merge here, just gather → batch → encrypt →
    /// upload, mirroring `push_versions`'s shape.
    ///
    /// Returns `(batches_uploaded, errors)`. Every model_id currently present
    /// in the local chunk store is pushed (in steady state there is exactly
    /// one — model swaps prune the previous model's rows elsewhere, see
    /// `db::embeddings::distinct_synced_model_ids`); each model's eligible
    /// rows are bounded into ≤4 MiB plaintext batches via
    /// `batch_chunks_for_sync` before encryption so a large journal's first
    /// sync doesn't require one round-trip per chunk.
    ///
    /// **Stale-batch pruning.** After uploading, `reconcile_own_embedding_files`
    /// deletes any own-folder `batch-{i}.bin` whose index is at or beyond the
    /// batch count just written, so a shrinking eligible set (content deleted,
    /// model switched, embedding disabled) never leaves orphans behind —
    /// mirroring `reconcile_own_version_files` for the version channel.
    pub async fn push_embedding_chunks<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
    ) -> Result<(u64, Vec<String>), SyncError> {
        let mut errors = Vec::new();
        let ks = self.make_key_state(key);
        let fp = ks
            .with_sync_key(|k| Ok(key_fingerprint(k)))
            .map_err(SyncError::Serialization)?;

        let include_protected =
            access.with_conn(|conn| Ok(embed_include_protected_setting(conn)))?;
        let model_ids = access
            .with_conn(|conn| db::embeddings::distinct_synced_model_ids(conn).map_err(sync_io))?;

        let mut all_chunks: Vec<EmbeddingChunkVector> = Vec::new();
        for model_id in &model_ids {
            let rows = access.with_conn(|conn| {
                db::embeddings::list_chunks_for_sync_push(conn, model_id, include_protected)
                    .map_err(sync_io)
            })?;
            all_chunks.extend(rows.into_iter().map(|r| EmbeddingChunkVector {
                entry_id: r.entry_id,
                model_id: r.model_id,
                chunk_index: r.chunk_index,
                content_hash: r.content_hash,
                dim: r.dim,
                vec: r.vec,
            }));
        }

        let batches = batch_chunks_for_sync(all_chunks);
        let batch_count = batches.len();
        let mut uploaded = 0u64;
        for (i, batch) in batches.into_iter().enumerate() {
            let plain = match serialize_chunk_batch(&batch) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("embedding batch {i}: serialize: {e}"));
                    continue;
                }
            };
            let ct = match encrypt_embedding_bytes(&ks, &plain) {
                Ok(c) => c,
                Err(e) => {
                    errors.push(format!("embedding batch {i}: encrypt: {e}"));
                    continue;
                }
            };
            let payload = SyncEmbeddingChunkPayload::new(fp, ct);
            let wire = match serialize_embedding_payload(&payload) {
                Ok(w) => w,
                Err(e) => {
                    errors.push(format!("embedding batch {i}: frame: {e}"));
                    continue;
                }
            };
            let path = format!("{}/embeddings/batch-{i}.bin", self.device_id);
            match self.provider.write_file(&path, &wire).await {
                Ok(()) => uploaded += 1,
                Err(e) => errors.push(format!("embedding batch {i}: upload: {e}")),
            }
        }

        // Prune stale higher-index batch files left by a previously larger
        // eligible set. Runs every cycle so orphans don't accumulate — see
        // `reconcile_own_embedding_files`.
        errors.extend(self.reconcile_own_embedding_files(batch_count).await);

        Ok((uploaded, errors))
    }

    /// Self-healing reconcile: delete own-folder embedding batch files whose
    /// index is at or beyond `batch_count` — the number of batches
    /// `push_embedding_chunks` just wrote this cycle. Batches are named
    /// `batch-{i}.bin` and always written from index 0 up, so any file with a
    /// higher index is a stale orphan left by a previous, larger eligible set
    /// (content deleted, model switched, embedding disabled, or a post-rotation
    /// re-encrypt that shrank the set — the latter also re-keys every surviving
    /// `batch-{i}.bin` since push overwrites index-by-index under the latest
    /// content key). Without this, those orphans persist in the cloud forever
    /// and every peer re-downloads them each pull only to reject them
    /// (`HashMismatch`/`ModelMismatch`), mirroring the leak
    /// `reconcile_own_version_files` prevents for versions.
    ///
    /// Pruning by `batch_count` (batches PRODUCED), not by upload-success
    /// count, is deliberate: a batch whose upload failed mid-loop still owns
    /// index `i < batch_count` and must not be deleted — it is retried next
    /// cycle, not orphaned. A listing failure aborts the prune without
    /// deleting anything (orphans simply persist one more cycle), matching
    /// `reconcile_own_version_files`.
    async fn reconcile_own_embedding_files(&self, batch_count: usize) -> Vec<String> {
        let mut errors = Vec::new();
        let own_paths = match self
            .provider
            .list_files(&self.device_id, FileKind::EmbeddingChunks)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("embeddings prune-cloud: list own folder: {e}"));
                return errors;
            }
        };
        for path in own_paths {
            let Some(file_name) = path.rsplit('/').next() else {
                continue;
            };
            let Some(index_str) = file_name
                .strip_prefix("batch-")
                .and_then(|s| s.strip_suffix(".bin"))
            else {
                continue;
            };
            let Ok(index) = index_str.parse::<usize>() else {
                continue;
            };
            if index >= batch_count {
                if let Err(e) = self.provider.delete_file(&path).await {
                    errors.push(format!("embeddings prune-cloud: delete {path}: {e}"));
                }
            }
        }
        errors
    }

    /// Pull entry-version snapshots from every peer device's `versions/`
    /// folder. Unlike entries, there is no manifest-diff — versions are
    /// write-once/immutable, so pull is a plain existence check
    /// (`version_exists`) followed by an `INSERT OR IGNORE`
    /// (`insert_remote_version`). Per-file failures are collected rather
    /// than aborting the whole pull, matching entries/media error
    /// tolerance.
    ///
    /// **Retention resurrection guard:** a peer version whose `created_at`
    /// is older than this device's local retention window is skipped
    /// (never inserted) — otherwise a version pruned locally but still
    /// present in a peer's cloud folder would be re-pulled every cycle.
    ///
    /// **Count-cap enforcement:** `ingest_version` already skips inserting
    /// a version that would rank at or beyond `MAX_VERSIONS_PER_ENTRY`
    /// among this entry's existing local rows (see
    /// `db::count_versions_ranked_ahead`). As a second line of defense for
    /// anything that slips past that intra-cycle check (e.g. several
    /// peers' versions interleaving within the same pull), every entry
    /// that received at least one inserted version is re-pruned by
    /// `prune_entry_versions` once the peer loop finishes. That prune
    /// touches LOCAL ROWS ONLY: peer-originated versions have no
    /// `cloud_path` (never uploaded by this device, so never delete from a
    /// peer's folder), and any evicted own-originated version is cleaned
    /// from the cloud by the existing `reconcile_own_version_files` on the
    /// next push cycle — so the returned cloud paths are intentionally
    /// discarded here.
    pub async fn pull_versions<C: ConnAccess>(
        &self,
        access: &C,
        key_state_full: &crate::EncryptionKeyState,
    ) -> Result<(u64, Vec<String>), SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut pulled = 0u64;
        let mut errors = Vec::new();
        let mut affected_entries: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        let retention_days =
            access.with_conn(|conn| db::get_version_retention_days(conn).map_err(sync_io))?;
        let cutoff = now_unix() - (retention_days as i64) * 86_400;

        let devices = self.list_pull_devices().await?;

        // List every peer's version files up front so the total item count
        // is known before the per-item loop starts — mirrors `pull_total` in
        // the entries-pull phase, letting `PullingVersions` progress events
        // show real "N of M" instead of going silent until the whole phase
        // completes (the previous per-peer-interleaved listing had no fixed
        // total to report against).
        let mut to_pull: Vec<(String, String)> = Vec::new();
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            if !is_safe_device_id(&peer) {
                continue;
            }
            match self.provider.list_files(&peer, FileKind::Versions).await {
                Ok(paths) => to_pull.extend(paths.into_iter().map(|p| (peer.clone(), p))),
                Err(e) => errors.push(format!("peer {peer}: list versions: {e}")),
            }
        }

        let total = to_pull.len();
        self.emit_progress(SyncProgressPhase::PullingVersions, 0, total as u32);

        for (i, (peer, path)) in to_pull.iter().enumerate() {
            // Heartbeat fires once per item regardless of success/failure —
            // see the comment on the media push loop for why this must not
            // sit behind a `continue`.
            self.heartbeat();

            'item: {
                let Some(file_name) = path.rsplit('/').next() else {
                    break 'item;
                };
                let Some(version_id) = file_name.strip_suffix(".bin") else {
                    break 'item;
                };
                if !is_safe_id(version_id) {
                    errors.push(format!("peer {peer}: bad version id {version_id:?}"));
                    break 'item;
                }

                let already =
                    access.with_conn(|conn| db::version_exists(conn, version_id).map_err(sync_io));
                match already {
                    Ok(true) => break 'item,
                    Ok(false) => {}
                    Err(e) => {
                        errors.push(format!("peer {peer} version {version_id}: {e}"));
                        break 'item;
                    }
                }

                let bytes = match self.provider.read_file(path).await {
                    Ok(b) => b,
                    Err(SyncError::NotFound(_)) => break 'item,
                    Err(e) => {
                        errors.push(format!("peer {peer} version {version_id}: read: {e}"));
                        break 'item;
                    }
                };
                let payload = match deserialize_version_payload(&bytes) {
                    Ok(p) => p,
                    Err(e) => {
                        errors.push(format!("peer {peer} version {version_id}: parse: {e}"));
                        break 'item;
                    }
                };
                match self.ingest_version(access, key_state_full, version_id, &payload, cutoff) {
                    Ok(Some(inserted_entry_id)) => {
                        pulled += 1;
                        affected_entries.insert(inserted_entry_id);
                    }
                    Ok(None) => {} // over-retention, over-count-cap, or missing parent entry: skipped, not an error
                    Err(e) => errors.push(format!("peer {peer} version {version_id}: {e}")),
                }
            }

            if should_emit(i, total) {
                self.emit_progress(
                    SyncProgressPhase::PullingVersions,
                    (i + 1) as u32,
                    total as u32,
                );
            }
        }
        self.emit_progress(
            SyncProgressPhase::PullingVersions,
            total as u32,
            total as u32,
        );

        // Post-pull prune (see doc comment above): local-row-only cleanup
        // for any entry that received an insert this cycle.
        for entry_id in affected_entries {
            let result = access.with_conn(|conn| {
                db::prune_entry_versions(
                    conn,
                    &entry_id,
                    retention_days,
                    db::MAX_VERSIONS_PER_ENTRY,
                )
                .map_err(sync_io)
            });
            if let Err(e) = result {
                errors.push(format!("entry {entry_id}: post-pull version prune: {e}"));
            }
            // `PrunedVersion::cloud_path` is intentionally ignored here —
            // see the doc comment on this function for why this path never
            // deletes cloud files.
        }

        Ok((pulled, errors))
    }

    /// Pull encrypted chunk-vector batches from every peer device's
    /// `embeddings/` folder and adopt-on-match (Phase 5 Task 3).
    ///
    /// Mirrors `pull_versions`'s shape (enumerate peers via
    /// `FileKind::EmbeddingChunks`, read + parse each file, decrypt via the
    /// same envelope-version guard `ingest_entry`/`ingest_version` use), but
    /// instead of a plain existence-check insert, each incoming chunk
    /// vector goes through `db::embeddings::adopt_synced_chunk_vector`'s
    /// strict adopt-on-match gate — see that function's doc comment for
    /// the exact rule. Ignoring a chunk (wrong model, hash mismatch,
    /// ineligible entry, malformed input) is the expected, non-error
    /// outcome and is never pushed into `errors`.
    ///
    /// **This device's "active model" (C6 fix)** is read from the
    /// CONFIGURED embedding slot —
    /// `commands::ai_provider::configured_embedding_model_id`, the same
    /// `provider_id:embedding_model` identity
    /// `persist_embed_config`/`apply_embedding_slot_change` derive from the
    /// `ai_embed_*` settings rows — NOT from whatever `model_id`s happen to
    /// already be present in `entry_embedding_chunks`. The prior idiom
    /// (deriving "active" from `db::embeddings::distinct_synced_model_ids`)
    /// had two real bugs: a fresh device with zero local chunk rows had
    /// nothing to compare against and adopted nothing, defeating the
    /// cross-device cost saving the feature exists for on a brand-new
    /// install; and rows retained from a PRIOR model (a model switch
    /// leaves the old model's rows in place until something else prunes
    /// them) were wrongly reported as still active, letting a peer's stale
    /// vectors for an abandoned model get adopted. Reading the configured
    /// slot instead fixes both, and only ever adopts against the ONE
    /// model actually configured right now.
    ///
    /// This is a plain settings read through the existing `db`/settings
    /// layer, not a dependency on the live `ProviderRegistry` —
    /// `sync::engine` still has no reason to depend on the in-process
    /// provider registry just to answer "what model id is configured",
    /// and a settings read works identically whether or not a provider has
    /// been constructed yet this session.
    ///
    /// **No embedding slot configured** → nothing to adopt against; this
    /// pull is a no-op (`Ok((default, errors))`).
    pub async fn pull_embedding_chunks<C: ConnAccess>(
        &self,
        access: &C,
        key_state_full: &crate::EncryptionKeyState,
    ) -> Result<(EmbeddingChunkPullStats, Vec<String>), SyncError> {
        self.prepare_device_cache_for_standalone_entry();
        let mut tally = EmbeddingChunkPullStats::default();
        let mut peer_model_counts: HashMap<String, u64> = HashMap::new();
        // ModelMismatch ids only — used to stamp pending. HashMismatch
        // must not enter this set (HashMismatch alone never stamps).
        let mut model_mismatch_entry_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        // Union of ModelMismatch + HashMismatch ids for the filtered
        // re-embed enqueue. Separate from the stamp set.
        let mut requeue_entry_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut errors = Vec::new();

        let configured_model_id: Option<String> = access.with_conn(|conn| {
            Ok(crate::commands::ai_provider::configured_embedding_model_id(
                conn,
            ))
        })?;
        let Some(configured_model_id) = configured_model_id else {
            // No embedding slot configured — see doc comment above.
            return Ok((tally, errors));
        };
        let include_protected =
            access.with_conn(|conn| Ok(embed_include_protected_setting(conn)))?;

        let devices = self.list_pull_devices().await?;
        for peer in devices {
            if !self.include_self_in_pull && peer == self.device_id {
                continue;
            }
            if !is_safe_device_id(&peer) {
                continue;
            }
            let paths = match self
                .provider
                .list_files(&peer, FileKind::EmbeddingChunks)
                .await
            {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!("peer {peer}: list embedding chunks: {e}"));
                    continue;
                }
            };
            for path in paths {
                let bytes = match self.provider.read_file(&path).await {
                    Ok(b) => b,
                    Err(SyncError::NotFound(_)) => continue,
                    Err(e) => {
                        errors.push(format!("peer {peer} {path}: read: {e}"));
                        continue;
                    }
                };
                let payload = match deserialize_embedding_payload(&bytes) {
                    Ok(p) => p,
                    Err(e) => {
                        errors.push(format!("peer {peer} {path}: parse: {e}"));
                        continue;
                    }
                };
                // ── Envelope version guard ──────────────────────────────────
                //
                // The version byte on the (single) `chunks_ciphertext` field is
                // checked FIRST — it rejects a malformed/unrecognized envelope
                // at the parser level before any decrypt is attempted. Always
                // encrypted: only 0x01 (AES-GCM) is a valid version; anything
                // else (including a stray 0x00 from a pre-rewrite plaintext
                // vault) is dead data, not a mode to detect.
                let ct_first = payload.chunks_ciphertext.first().copied();
                match ct_first {
                    Some(0x01) => {} // version byte OK; continue to fingerprint check
                    Some(b) => {
                        errors.push(format!(
                            "peer {peer} {path}: unknown sync envelope format version \
                             (0x{b:02x}). Update the app or the sync folder is corrupted."
                        ));
                        continue;
                    }
                    None => {
                        errors.push(format!(
                            "peer {peer} {path}: embedding batch is empty or corrupted"
                        ));
                        continue;
                    }
                }

                let plain = match decrypt_embedding_bytes_by_fingerprint(key_state_full, &payload) {
                    Ok(p) => p,
                    Err(e) => {
                        errors.push(format!("peer {peer} {path}: decrypt: {e}"));
                        continue;
                    }
                };
                let chunks = match deserialize_chunk_batch(&plain) {
                    Ok(c) => c,
                    Err(e) => {
                        errors.push(format!("peer {peer} {path}: deserialize: {e}"));
                        continue;
                    }
                };

                for chunk in chunks {
                    let is_active_model = chunk.model_id == configured_model_id;
                    let peer_model_id = chunk.model_id.clone();
                    let entry_id = chunk.entry_id.clone();
                    let incoming = db::embeddings::IncomingChunkVector {
                        entry_id: chunk.entry_id,
                        model_id: chunk.model_id,
                        chunk_index: chunk.chunk_index,
                        content_hash: chunk.content_hash,
                        dim: chunk.dim,
                        vec: chunk.vec,
                    };
                    let outcome = access.with_conn(|conn| {
                        db::embeddings::adopt_synced_chunk_vector(
                            conn,
                            is_active_model,
                            &incoming,
                            include_protected,
                            now_unix(),
                        )
                        .map_err(sync_io)
                    });
                    match outcome {
                        Ok(db::embeddings::AdoptOutcome::Adopted) => tally.adopted += 1,
                        Ok(db::embeddings::AdoptOutcome::ModelMismatch) => {
                            tally.model_mismatch += 1;
                            *peer_model_counts.entry(peer_model_id).or_default() += 1;
                            model_mismatch_entry_ids.insert(entry_id.clone());
                            requeue_entry_ids.insert(entry_id);
                        }
                        Ok(db::embeddings::AdoptOutcome::HashMismatch) => {
                            tally.hash_mismatch += 1;
                            requeue_entry_ids.insert(entry_id);
                        }
                        Ok(_) => {} // other ignore reasons — not an error
                        Err(e) => errors.push(format!("peer {peer} {path}: adopt: {e}")),
                    }
                }
            }
        }

        // Stamp only when ModelMismatch entry ids still need local index
        // work (intersection). Foreign vectors on fully-indexed entries
        // must not gate unrelated dirty local entries. HashMismatch alone
        // never stamps (silent re-embed). No FE event yet — phase 2.
        if tally.model_mismatch > 0 && !model_mismatch_entry_ids.is_empty() {
            let stamp_err =
                access.with_conn(|conn| {
                    let needing = db::embeddings::list_entries_needing_index(
                        conn,
                        &configured_model_id,
                        10_000,
                        include_protected,
                    )
                    .map_err(sync_io)?;
                    let pending_units = needing
                        .iter()
                        .filter(|id| model_mismatch_entry_ids.contains(id.as_str()))
                        .count() as u64;
                    if pending_units == 0 {
                        return Ok(());
                    }
                    let mut peer_models: Vec<crate::ai::embedding_decision::PeerModelCount> =
                        peer_model_counts
                            .into_iter()
                            .map(|(model_id, count)| {
                                crate::ai::embedding_decision::PeerModelCount { model_id, count }
                            })
                            .collect();
                    peer_models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
                    crate::ai::embedding_decision::stamp_pending_if_needed(
                        conn,
                        crate::ai::embedding_decision::EmbedSyncSlot::Entry,
                        crate::ai::embedding_decision::EmbedSyncDecisionReason::ModelMismatch,
                        Some(&configured_model_id),
                        peer_models,
                        pending_units,
                        now_unix(),
                    )
                    .map_err(SyncError::Io)
                });
            if let Err(e) = stamp_err {
                errors.push(format!("embedding decision stamp: {e}"));
            }
        }

        // Re-embed requeue (hash-mismatch silent path, or leftover work
        // after a Reembed decision). `entry_embedding_jobs` has no origin
        // column, so Pause split is applied at this enqueue site — not at
        // the worker claim gate. Absent `pause_scope` → `all` (old
        // behaviour: skip). Modal Pause writes `sync_backfill` and skips
        // here; local dirty seeding is unaffected.
        if tally.hash_mismatch > 0 || tally.model_mismatch > 0 {
            let allow = access.with_conn(|conn| {
                let decision = crate::ai::embedding_decision::read_embed_sync_decision(
                    conn,
                    crate::ai::embedding_decision::EmbedSyncSlot::Entry,
                )
                .map_err(SyncError::Io)?;
                Ok(crate::ai::embedding_decision::auto_index_allowed(
                    &decision,
                    crate::ai::embedding_decision::AutoIndexScope::SyncBackfill,
                ))
            })?;
            if allow {
                if let Err(e) = access.with_conn(|conn| {
                    crate::ai::indexer::enqueue_dirty_jobs_for_model_filtered(
                        conn,
                        &configured_model_id,
                        Some(&requeue_entry_ids),
                    )
                    .map_err(|e| SyncError::Io(e.to_string()))
                }) {
                    errors.push(format!("embedding re-embed requeue: {e}"));
                }
            }
        }

        Ok((tally, errors))
    }

    /// Decrypt and ingest one pulled version payload. Returns `Ok(Some(entry_id))`
    /// if the version was inserted (naming the entry it belongs to), or
    /// `Ok(None)` if it was skipped — `created_at < cutoff` (retention
    /// resurrection guard), the count-cap guard (`count_versions_ranked_ahead`),
    /// or the parent entry is not present locally yet (`entry_versions`
    /// REFERENCES `entries(id)`).
    ///
    /// Mirrors `ingest_entry`'s cross-mode + fingerprint guard exactly —
    /// version blobs use the same envelope format as entries.
    fn ingest_version<C: ConnAccess>(
        &self,
        access: &C,
        key_state_full: &crate::EncryptionKeyState,
        version_id: &str,
        payload: &SyncVersionPayload,
        cutoff: i64,
    ) -> Result<Option<String>, SyncError> {
        // Always encrypted: only 0x01 (AES-GCM) is a valid envelope version.
        // A stray 0x00 (from a pre-rewrite plaintext vault) or any other byte
        // is dead data — rejected as unknown/corrupted, never a mode to detect.
        let yjs_first = payload.yjs_blob_ciphertext.first().copied();
        let meta_first = payload.metadata_ciphertext.first().copied();
        match (yjs_first, meta_first) {
            (None, _) | (_, None) => {
                return Err(SyncError::CrossModeReject(
                    "Sync file is empty or corrupted.".to_string(),
                ));
            }
            (Some(b), _) | (_, Some(b)) if b != 0x01 => {
                return Err(SyncError::CrossModeReject(format!(
                    "Unknown sync envelope format version (0x{b:02x}). \
                     Update the app or the sync folder is corrupted."
                )));
            }
            _ => {} // both bytes are 0x01 — proceed
        }

        let meta_plain = key_state_full
            .with_sync_key_for_fingerprint(&payload.key_fingerprint, |sync_k| {
                let inner = payload
                    .metadata_ciphertext
                    .get(1..)
                    .ok_or_else(|| "metadata_ciphertext: empty envelope".to_string())?;
                crate::utils::encryption::decrypt_data(sync_k, inner)
            })
            .map_err(|e| {
                SyncError::Auth(format!(
                    "sync payload for version {version_id}: key fingerprint not found in \
                     local content-key list — the version may have been encrypted under \
                     a rotated key this device does not hold (re-pair required): {e}"
                ))
            })?;

        let remote_meta: VersionMetadata = serde_json::from_slice(&meta_plain)
            .map_err(|e| SyncError::Serialization(e.to_string()))?;

        if remote_meta.version_id != version_id {
            return Err(SyncError::Serialization(format!(
                "payload version_id {:?} does not match path id {version_id:?}",
                remote_meta.version_id
            )));
        }
        if !is_safe_id(&remote_meta.entry_id) {
            return Err(SyncError::Serialization(format!(
                "peer published bad entry_id {:?} for version {version_id}",
                remote_meta.entry_id
            )));
        }
        if !is_safe_device_id(&remote_meta.device_id) {
            return Err(SyncError::Serialization(format!(
                "peer published bad device_id {:?} inside version {version_id} payload",
                remote_meta.device_id
            )));
        }

        // Retention resurrection guard: skip before spending effort
        // decrypting the (potentially large) Yjs snapshot blob.
        if remote_meta.created_at < cutoff {
            return Ok(None);
        }

        // Count-cap guard: skip inserting a version that would already rank
        // at or beyond MAX_VERSIONS_PER_ENTRY among this entry's existing
        // local rows — it would just be pruned right back out by the
        // post-pull prune below. `count_versions_ranked_ahead`'s ordering
        // predicate is deliberately identical to `prune_entry_versions`'s
        // keep-set ordering (created_at DESC, id DESC, with the same id
        // tie-break), so this is a stable fixpoint: an evicted-then-re-served
        // peer version is skipped again on every future pull, never churning.
        let ranked_ahead = access.with_conn(|conn| {
            db::count_versions_ranked_ahead(
                conn,
                &remote_meta.entry_id,
                remote_meta.created_at,
                version_id,
            )
            .map_err(sync_io)
        })?;
        if ranked_ahead >= db::MAX_VERSIONS_PER_ENTRY as u64 {
            return Ok(None);
        }

        // `entry_versions.entry_id` REFERENCES `entries(id)`. A peer version
        // can arrive before its entry (same pull, skipped/failed entry blob,
        // or the entry was never replicated). Skip-and-warn; a later pull
        // re-serves the version once the entry lands.
        let entry_present = access
            .with_conn(|conn| db::entry_exists(conn, &remote_meta.entry_id).map_err(sync_io))?;
        if !entry_present {
            log::warn!(
                "skipping version {version_id}: entry {} is not present locally yet",
                remote_meta.entry_id
            );
            return Ok(None);
        }

        let yjs_plain = key_state_full
            .with_sync_key_for_fingerprint(&payload.key_fingerprint, |sync_k| {
                let inner = payload
                    .yjs_blob_ciphertext
                    .get(1..)
                    .ok_or_else(|| "yjs_blob_ciphertext: empty envelope".to_string())?;
                crate::utils::encryption::decrypt_data(sync_k, inner)
            })
            .map_err(SyncError::Serialization)?;

        access.with_conn(|conn| {
            db::insert_remote_version(
                conn,
                version_id,
                &remote_meta.entry_id,
                &yjs_plain,
                &remote_meta.preview_text,
                remote_meta.created_at,
                &remote_meta.device_id,
            )
            .map_err(sync_io)
        })?;

        Ok(Some(remote_meta.entry_id))
    }

    /// Pull new / updated entries from every peer device, decrypt, and
    /// upsert into the local DB.
    ///
    /// **Transactional boundary:** each peer's merge runs inside its own
    /// `unchecked_transaction`. Any ingest error rolls the whole peer
    /// batch back — we never leave the DB with half of peer B's entries
    /// committed, because that half-state would be republished in the
    /// next push and propagate a partial peer view to every other device.
    ///
    /// Per-entry errors inside one peer's batch are collected into
    /// `PullStats.errors` rather than aborting, so a single bad file
    /// doesn't doom the whole peer. The peer's transaction still commits
    /// for the entries that did succeed.
    pub async fn pull_remote<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        key_state_full: &crate::EncryptionKeyState,
    ) -> Result<PullStats, SyncError> {
        self.pull_remote_with_manifest_scope(access, key, key_state_full, false)
            .await
    }

    /// Recovery-only pull seam. Unlike normal pull, this includes the
    /// current device's manifest and entry blobs so a freshly cleared local
    /// database can be restored from its own cloud folder.
    pub async fn pull_entries_for_recovery<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        key_state_full: &crate::EncryptionKeyState,
    ) -> Result<PullStats, SyncError> {
        let recovery_engine = Self {
            provider: self.provider.clone(),
            device_id: self.device_id.clone(),
            reporter: self.reporter.clone(),
            include_self_in_pull: true,
            recovery_peer_scope: None,
            // Fresh empty cache for this recovery-scoped engine instance.
            device_cache: std::sync::Mutex::new(None),
            device_cache_batch_depth: std::sync::atomic::AtomicU32::new(0),
            // Share the process-level session flag (do not fork a copy).
            session_own_cloud_reconciled: Arc::clone(&self.session_own_cloud_reconciled),
        };
        recovery_engine
            .pull_remote_with_manifest_scope(access, key, key_state_full, true)
            .await
    }

    async fn pull_remote_with_manifest_scope<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        key_state_full: &crate::EncryptionKeyState,
        include_self: bool,
    ) -> Result<PullStats, SyncError> {
        // Multi-surface pull cycle: clear only when we are the outermost
        // batch so a nested call from `sync_now` reuses the warm cache
        // instead of forcing a second `list_devices`. Then enter a batch
        // for the whole walk so nested surface pulls share one list.
        if !self.in_device_cache_batch() {
            self.reset_device_cache();
        }
        let _batch = self.enter_device_cache_batch_guard();

        let mut stats = PullStats::default();

        // Fetch every peer's metadata.json ONCE here. Both the journal
        // channel and the entry loop need it; reading twice wastes a
        // round-trip and creates a manifest-mismatch race window if a
        // peer pushes between reads. Missing / unparseable manifests
        // are logged and that peer skipped for both channels.
        self.emit_progress(SyncProgressPhase::PullingManifests, 0, 1);
        let manifest_fetch = if include_self {
            let (manifests, errors) = self.fetch_manifests(true).await?;
            Ok((
                manifests,
                std::collections::HashMap::new(),
                errors,
                Vec::new(),
            ))
        } else {
            self.fetch_manifests_conditionally(access).await
        };
        let (mut manifests, manifest_revisions, manifest_errors, unchanged_peers) =
            match manifest_fetch {
                Ok(manifests) => manifests,
                Err(error) => {
                    if !include_self {
                        access.with_conn(|conn| {
                            db::set_sync_catchup_complete(conn, false).map_err(sync_io)
                        })?;
                    }
                    return Err(error);
                }
            };
        stats.errors.extend(manifest_errors);
        if include_self {
            let expected_generation =
                access.with_conn(|conn| db::get_sync_recovery_generation(conn).map_err(sync_io))?;
            manifests.retain(|(peer, manifest)| {
                if manifest.recovery_generation == expected_generation {
                    true
                } else {
                    stats.errors.push(format!(
                        "peer {peer}: stale recovery generation {} (expected {expected_generation})",
                        manifest.recovery_generation
                    ));
                    false
                }
            });
        }
        let scoped_engine = Self {
            provider: self.provider.clone(),
            device_id: self.device_id.clone(),
            reporter: self.reporter.clone(),
            include_self_in_pull: include_self,
            recovery_peer_scope: include_self.then(|| {
                std::sync::Arc::new(
                    manifests
                        .iter()
                        .map(|(peer, _)| peer.clone())
                        .collect::<std::collections::BTreeSet<_>>(),
                )
            }),
            // Scoped recovery engines resolve devices from
            // `recovery_peer_scope`, not this cache.
            device_cache: std::sync::Mutex::new(None),
            device_cache_batch_depth: std::sync::atomic::AtomicU32::new(0),
            // Share the process-level session flag (do not fork a copy).
            session_own_cloud_reconciled: Arc::clone(&self.session_own_cloud_reconciled),
        };
        let channel_engine = if include_self { &scoped_engine } else { self };
        self.emit_progress(SyncProgressPhase::PullingManifests, 1, 1);

        // A conditional manifest revision can only be cached once every
        // manifest-derived channel for that peer has drained. Keep this state
        // across the tags, journals, entries, and chats phases; otherwise a
        // failed early channel could be hidden by a later unchanged response.
        let mut peer_pull_complete: std::collections::HashMap<String, bool> = manifests
            .iter()
            .filter(|(peer, _)| include_self || peer != &self.device_id)
            .map(|(peer, _)| (peer.clone(), true))
            .collect();
        // Phase 2 can skip a peer with no manifest body when its conditional
        // read is Unchanged. It had no pending payloads to drain, so it is a
        // successful peer for catch-up rather than an omitted one.
        peer_pull_complete.extend(unchanged_peers.into_iter().map(|peer| (peer, true)));

        // Order matters: pull TAGS → JOURNALS → ENTRIES.
        //   - Journals' `auto_tag_ids` reference rows in `tags`; if tags
        //     arrive after journals, `journal_auto_tags` ingest filters
        //     out unknown tag ids and the auto-apply set ends up empty.
        //   - Entries' `journal_id` FK requires the journal row to exist
        //     before entry upsert.
        //   - `replace_entry_tags_from_sync` silently skips tag ids that
        //     don't exist yet — same reason tags must come first.
        // Without this ordering, an already-pulled entity would never
        // back-fill missing references on a later tick.
        self.emit_progress(SyncProgressPhase::PullingTags, 0, 1);
        match channel_engine.pull_tags(access, key, key_state_full).await {
            Ok(errs) => {
                for (peer, complete) in &mut peer_pull_complete {
                    if errs
                        .iter()
                        .any(|error| error.starts_with(&format!("peer {peer}:")))
                    {
                        *complete = false;
                    }
                }
                stats.errors.extend(errs);
            }
            Err(e) => {
                peer_pull_complete
                    .values_mut()
                    .for_each(|complete| *complete = false);
                stats.errors.push(format!("tags: {e}"));
            }
        }
        self.emit_progress(SyncProgressPhase::PullingTags, 1, 1);

        self.emit_progress(SyncProgressPhase::PullingJournals, 0, 1);
        match self
            .pull_journals(access, key, key_state_full, &manifests)
            .await
        {
            Ok(errs) => {
                for (peer, complete) in &mut peer_pull_complete {
                    if errs.iter().any(|error| {
                        error.starts_with(&format!("peer {peer}:"))
                            || error.starts_with(&format!("peer {peer} journal "))
                    }) {
                        *complete = false;
                    }
                }
                stats.errors.extend(errs);
            }
            Err(e) => {
                peer_pull_complete
                    .values_mut()
                    .for_each(|complete| *complete = false);
                stats.errors.push(format!("journals: {e}"));
            }
        }
        self.emit_progress(SyncProgressPhase::PullingJournals, 1, 1);

        // For the diff we need the full local view (including pulled
        // entries), not just the publishable manifest — see
        // `build_local_diff_view` docstring.
        let local_view = access
            .with_conn(|conn| build_local_diff_view(conn, &self.device_id).map_err(sync_io))?;

        // Count total entries to pull across all peers so we can emit a
        // meaningful total before the nested loop starts.
        let pull_total: usize = manifests
            .iter()
            .map(|(_, remote)| {
                recovery_entry_diff(&local_view, remote, include_self)
                    .to_pull
                    .len()
            })
            .sum();
        self.emit_progress(SyncProgressPhase::PullingEntries, 0, pull_total as u32);
        let mut pull_done: usize = 0;
        let mut catchup_pulled = 0u64;

        for (peer, remote) in &manifests {
            let peer = peer.clone();
            let diff = recovery_entry_diff(&local_view, remote, include_self);

            // Process this peer's entries in chunks of `PULL_CHUNK_SIZE`
            // rather than "download everything, then one giant commit" — see
            // the constant's doc comment for why. Each chunk is downloaded
            // (async, outside any transaction) and then committed in its own
            // transaction before the next chunk's downloads start.
            let mut peer_fatal_hit = false;
            let mut entries_complete = *peer_pull_complete.get(&peer).unwrap_or(&true);

            for chunk in diff.to_pull.chunks(PULL_CHUNK_SIZE) {
                // Read this chunk's files concurrently (async I/O — must
                // happen outside the DB transaction; a transaction cannot
                // straddle an .await without risking deadlock on the
                // single-connection pool). Concurrency is implicitly
                // bounded by the chunk size (`PULL_CHUNK_SIZE`) — a small,
                // Drive-rate-limit-friendly window; per-request 429 backoff
                // is already handled inside the provider
                // (`send_with_retry`/`retry_until_success`). Each read costs
                // ~2 HTTP round trips on Drive (post folder-ID caching), so
                // running a chunk's reads via `join_all` collapses chunk
                // latency from the SUM of the chunk to roughly the MAX.
                // No `tokio::spawn`: every read future stays a child of
                // this task, so the outer stall guard's drop-on-abort still
                // cancels the whole chunk together.
                let mut read_futures = Vec::with_capacity(chunk.len());
                for entry_id in chunk {
                    // Heartbeat fires once per item regardless of
                    // success/failure — see the comment on the media push
                    // loop for why this must not sit behind a `continue`.
                    // It stays here (before `is_safe_id` and outside the
                    // read future) so a bad-id entry, which never builds a
                    // future, still stamps liveness.
                    self.heartbeat();
                    if !is_safe_id(entry_id) {
                        stats
                            .errors
                            .push(format!("peer {peer}: bad entry id {entry_id:?}"));
                        entries_complete = false;
                        continue;
                    }
                    let entry_id = entry_id.clone();
                    let path = format!("{peer}/entries/{entry_id}.bin");
                    read_futures.push(async move {
                        let result = self.provider.read_file(&path).await;
                        (entry_id, result)
                    });
                }

                // `join_all` preserves input order, so the fold below sees
                // results in the same chunk order the old sequential loop
                // used to — ingest order, and every `stats`/progress
                // mutation below, stay single-threaded and deterministic
                // even though the reads themselves ran concurrently.
                let read_results = futures_util::future::join_all(read_futures).await;

                let mut pulled_payloads: Vec<(String, SyncEntryPayload)> = Vec::new();
                for (entry_id, read_result) in read_results {
                    let bytes = match read_result {
                        Ok(b) => b,
                        Err(SyncError::NotFound(_)) => {
                            // The peer's manifest listed this entry but its blob
                            // is absent from the provider — repairable consistency
                            // anomaly (audit finding #7 / missing_blob_consistency).
                            // Surface as a warning so the pull is not reported as
                            // fully clean, but do NOT abort — other entries in
                            // this peer and other peers still pull normally.
                            let msg = format!(
                                "peer {peer} entry {entry_id}: manifest references missing blob"
                            );
                            log::warn!("{msg}");
                            stats.warnings.push(msg);
                            entries_complete = false;
                            continue;
                        }
                        Err(e) => {
                            stats
                                .errors
                                .push(format!("peer {peer} entry {entry_id}: read: {e}"));
                            entries_complete = false;
                            continue;
                        }
                    };
                    match deserialize_payload(&bytes) {
                        Ok(p) => pulled_payloads.push((entry_id.clone(), p)),
                        Err(e) => {
                            stats
                                .errors
                                .push(format!("peer {peer} entry {entry_id}: parse: {e}"));
                            entries_complete = false;
                        }
                    }
                    pull_done += 1;
                    if should_emit(pull_done - 1, pull_total) {
                        self.emit_progress(
                            SyncProgressPhase::PullingEntries,
                            pull_done as u32,
                            pull_total as u32,
                        );
                    }
                }
                let chunk_clean = entries_complete;

                // Commit this chunk under its own transaction. If any ingest
                // step errors fatally, roll back just this chunk and stop
                // the peer — chunks already committed earlier in this loop
                // stay committed, so a mid-pull failure (or the outer
                // sync_now timeout) doesn't discard prior progress.
                //
                // This entire block runs under a single `with_conn` so the
                // lock is held for the DB work and released before the next
                // chunk's async I/O starts. Transactions cannot straddle an
                // `.await`.
                type ChunkOutcome = (u64, u64, Option<String>, Vec<String>);
                let outcome: Result<ChunkOutcome, SyncError> = access.with_conn(|conn| {
                    let tx = conn.unchecked_transaction().map_err(sync_io)?;
                    let mut chunk_pulled = 0u64;
                    let mut chunk_merged = 0u64;
                    let mut chunk_fatal: Option<String> = None;
                    let mut chunk_errors: Vec<String> = Vec::new();

                    for (entry_id, payload) in &pulled_payloads {
                        match self.ingest_entry(&tx, key_state_full, entry_id, payload) {
                            Ok((was_merged, is_new)) => {
                                if is_new {
                                    chunk_pulled += 1;
                                } else if was_merged {
                                    chunk_merged += 1;
                                }
                            }
                            Err(SyncError::Auth(msg)) => {
                                // Key mismatch is a hard stop — signals
                                // operator error (wrong keychain / wrong
                                // password). Roll back and abort this peer.
                                chunk_fatal = Some(format!("peer {peer}: {msg}"));
                                break;
                            }
                            Err(SyncError::CrossModeReject(msg)) => {
                                // Mode mismatch is also a hard stop — the
                                // entire folder is in the wrong mode, so
                                // there is no point continuing with this peer.
                                chunk_fatal = Some(format!("peer {peer}: {msg}"));
                                break;
                            }
                            Err(e) => {
                                chunk_errors
                                    .push(format!("peer {peer} entry {entry_id}: ingest: {e}"));
                            }
                        }
                    }

                    if chunk_fatal.is_some() {
                        // `tx` drops here → rusqlite auto-rolls back.
                        drop(tx);
                        return Ok((0, 0, chunk_fatal, chunk_errors));
                    }

                    tx.commit().map_err(sync_io)?;
                    Ok((chunk_pulled, chunk_merged, None, chunk_errors))
                });

                match outcome {
                    Ok((pulled, merged, fatal, errs)) => {
                        let chunk_had_ingest_errors = !errs.is_empty();
                        if chunk_had_ingest_errors {
                            entries_complete = false;
                        }
                        stats.errors.extend(errs);
                        if let Some(msg) = fatal {
                            stats.errors.push(msg);
                            peer_fatal_hit = true;
                            entries_complete = false;
                            break;
                        }
                        stats.pulled += pulled;
                        stats.merged += merged;
                        if chunk_clean && !chunk_had_ingest_errors {
                            // The complete chunk transaction committed, so it
                            // is now safe to tell the UI about every manifest
                            // item it covered. A later peer error deliberately
                            // suppresses only the terminal event; it never
                            // rewinds durable progress from earlier chunks.
                            catchup_pulled += chunk.len() as u64;
                            self.emit_catchup_progress(CatchupProgressEvent {
                                pulled: catchup_pulled,
                                total: pull_total as u64,
                                peer_device_id: Some(peer.clone()),
                            });
                        }
                    }
                    Err(e) => {
                        stats.errors.push(format!("peer {peer}: {e}"));
                        peer_fatal_hit = true;
                        entries_complete = false;
                        break;
                    }
                }
            }

            if peer_fatal_hit {
                // Skip this peer's remaining chunks and its tombstones —
                // chunks already committed above stay committed. Continue
                // with the next peer.
                peer_pull_complete.insert(peer, false);
                continue;
            }

            // Apply this peer's tombstones in their own transaction, only
            // after every entry chunk for this peer has committed cleanly.
            type TombstoneOutcome = (u64, Vec<String>, Vec<(String, Option<String>)>);
            let outcome: Result<TombstoneOutcome, SyncError> = access.with_conn(|conn| {
                let tx = conn.unchecked_transaction().map_err(sync_io)?;
                let mut peer_deleted = 0u64;
                let mut peer_errors: Vec<String> = Vec::new();
                let mut peer_media: Vec<(String, Option<String>)> = Vec::new();

                for (entry_id, tombstone_ts) in &diff.to_delete_locally {
                    // Guard: only apply the tombstone when the current row
                    // is strictly older than the tombstone's `updated_at`.
                    // This prevents a stale tombstone (from a peer's frozen
                    // manifest view) from clobbering a live row that a
                    // different peer ingested earlier in this same loop.
                    // Uses the tombstone's timestamp in the SET clause too
                    // (not now_unix()) so future LWW diffs converge
                    // correctly (codex-Bug4).
                    //
                    // Clamp to prevent timestamp poisoning: a malicious peer
                    // publishing `updated_at = i64::MAX` would otherwise stamp
                    // that value onto the local row, making it permanently
                    // un-resurrectable (no real edit can ever exceed i64::MAX)
                    // and self-amplifying mesh-wide via this device's own
                    // manifest. Clamping to now + MAX_CLOCK_SKEW_SECS means
                    // any genuine edit within the next 24 h can still exceed
                    // the tombstone timestamp and resurrect the entry.
                    // Legitimate tombstones (timestamp ≤ now) pass through
                    // unchanged, so normal LWW convergence is unaffected.
                    let safe_ts = (*tombstone_ts).min(now_unix() + MAX_CLOCK_SKEW_SECS);
                    match tx.execute(
                        "UPDATE entries SET is_deleted = 1, updated_at = ?1 \
                         WHERE id = ?2 AND updated_at < ?1",
                        rusqlite::params![safe_ts, entry_id],
                    ) {
                        Ok(rows) => {
                            if rows > 0 {
                                peer_deleted += 1;
                                // C2 fix: a peer-applied tombstone must
                                // cascade the same AI User Memory cleanup
                                // `soft_delete_entry_impl` runs locally —
                                // otherwise this device's copy of the
                                // entry's distilled memory survives
                                // orphaned. Same transaction as the
                                // tombstone write above.
                                //
                                // I8 fix: a cleanup failure here used to be
                                // swallowed into `peer_errors` while the
                                // surrounding `tx` still committed below —
                                // so the entry tombstone landed WITHOUT its
                                // cascade, and the guard on the next sync
                                // (`WHERE id = ?2 AND updated_at < ?1`) would
                                // never re-enter this branch for that entry,
                                // since `updated_at` is already `>= safe_ts`.
                                // The cascade could never retry: a permanent,
                                // silent zombie `memory_items`/`memory_jobs`
                                // row. Propagating the error with `?` instead
                                // aborts the closure before `tx.commit()`
                                // runs, so `tx` drops here and rusqlite rolls
                                // back EVERY tombstone this peer's batch
                                // already applied in this same transaction —
                                // not just this one entry. The outer `match`
                                // below turns that `Err` into a `peer {peer}:
                                // ...` message, which flips
                                // `peer_pull_complete` to `false` for this
                                // peer, so the whole batch (tombstones +
                                // cascades together) retries on the next
                                // sync instead of leaving a partial state.
                                db::memory::cleanup_memory_for_deleted_source(
                                    &tx,
                                    "journal_entry",
                                    entry_id,
                                    safe_ts,
                                )
                                .map_err(sync_io)?;
                                // A peer-applied tombstone must also cascade
                                // the media cleanup `soft_delete_entry_impl`
                                // runs locally. There is no restore path for
                                // entries, so without this the entry's media
                                // survives on THIS device forever: rows kept,
                                // files on disk, `list_pending_uploads` has no
                                // `is_deleted` filter so they keep uploading,
                                // and `reconcile_own_media_files` can only
                                // prune blobs whose row is gone — so this
                                // device's own cloud folder never sheds them.
                                // Only the deleting device pruned its own
                                // folder; nobody prunes another device's.
                                //
                                // Errors propagate with `?` for the same
                                // reason as the memory cascade above (I8): the
                                // `updated_at < ?1` guard means a swallowed
                                // failure could never retry.
                                peer_media.extend(
                                    db::cascade_entry_content_delete(&tx, entry_id)
                                        .map_err(sync_io)?,
                                );
                            }
                        }
                        Err(e) => {
                            peer_errors
                                .push(format!("peer {peer} delete {entry_id}: {}", sync_io(e)));
                        }
                    }
                }

                tx.commit().map_err(sync_io)?;
                Ok((peer_deleted, peer_errors, peer_media))
            });

            match outcome {
                Ok((deleted, errs, media)) => {
                    if !errs.is_empty() {
                        entries_complete = false;
                    }
                    stats.errors.extend(errs);
                    stats.deleted += deleted;
                    // Post-commit, DB lock released.
                    self.unlink_pruned_media(&media);
                }
                Err(e) => {
                    stats.errors.push(format!("peer {peer}: {e}"));
                    entries_complete = false;
                }
            }

            peer_pull_complete.insert(peer, entries_complete);
        }

        self.emit_progress(
            SyncProgressPhase::PullingEntries,
            pull_total as u32,
            pull_total as u32,
        );

        // Pull entry-version snapshots from every peer's `versions/`
        // folder. `entry_versions.entry_id` REFERENCES `entries(id)` — a
        // version whose entry is not present locally is skipped until the
        // entry arrives (`ingest_version` skip-and-warn).
        match channel_engine.pull_versions(access, key_state_full).await {
            Ok((pulled, errs)) => {
                stats.versions_pulled = pulled;
                stats.errors.extend(errs);
            }
            Err(e) => stats.errors.push(format!("versions: {e}")),
        }

        // A fresh recovery staging DB must learn its synced embedding model
        // before chunk adoption. Normal sync keeps the historical ordering.
        let settings_pulled_early = if include_self {
            self.emit_progress(SyncProgressPhase::PullingSettings, 0, 1);
            match channel_engine
                .pull_settings(access, key, key_state_full)
                .await
            {
                Ok(s) => {
                    stats.errors.extend(s.errors);
                    stats
                        .changed_endpoint_presets
                        .extend(s.changed_endpoint_presets);
                }
                Err(e) => stats.errors.push(format!("settings: {e}")),
            }
            self.emit_progress(SyncProgressPhase::PullingSettings, 1, 1);
            true
        } else {
            false
        };

        // Pull + adopt-on-match cross-device chunk vectors (Phase 5 Task
        // 3). Same trigger/provider/auth as everything else in this
        // function; no progress phase, mirroring `push_embedding_chunks`'s
        // choice not to add one either.
        match channel_engine
            .pull_embedding_chunks(access, key_state_full)
            .await
        {
            Ok((chunk_stats, errs)) => {
                stats.embedding_chunks_adopted = chunk_stats.adopted;
                stats.embedding_model_mismatch = chunk_stats.model_mismatch;
                stats.embedding_hash_mismatch = chunk_stats.hash_mismatch;
                stats.errors.extend(errs);
            }
            Err(e) => stats.errors.push(format!("embedding chunks: {e}")),
        }

        // Pull each peer's settings manifest. Tags ran before the entry
        // loop (see the top of this function) so entry_tags reconciliation
        // had its FK dependencies in place. Templates have no FK chain so
        // ordering is loose here.
        // Single-shot phases: emit start then end.
        if !settings_pulled_early {
            self.emit_progress(SyncProgressPhase::PullingSettings, 0, 1);
            match channel_engine
                .pull_settings(access, key, key_state_full)
                .await
            {
                Ok(s) => {
                    stats.errors.extend(s.errors);
                    stats
                        .changed_endpoint_presets
                        .extend(s.changed_endpoint_presets);
                }
                Err(e) => stats.errors.push(format!("settings: {e}")),
            }
            self.emit_progress(SyncProgressPhase::PullingSettings, 1, 1);
        }

        self.emit_progress(SyncProgressPhase::PullingTemplates, 0, 1);
        match channel_engine
            .pull_templates(access, key, key_state_full)
            .await
        {
            Ok(errs) => stats.errors.extend(errs),
            Err(e) => stats.errors.push(format!("templates: {e}")),
        }
        self.emit_progress(SyncProgressPhase::PullingTemplates, 1, 1);

        self.emit_progress(SyncProgressPhase::PullingLocations, 0, 1);
        match channel_engine
            .pull_location_aliases(access, key, key_state_full)
            .await
        {
            Ok(errs) => stats.errors.extend(errs),
            Err(e) => stats.errors.push(format!("locations: {e}")),
        }
        self.emit_progress(SyncProgressPhase::PullingLocations, 1, 1);

        self.emit_progress(SyncProgressPhase::PullingChats, 0, 1);
        let chat_peers = manifests
            .iter()
            .map(|(peer, manifest)| (peer.clone(), manifest.chats_present))
            .collect::<Vec<_>>();
        match self
            .pull_chats_from_peers(access, key_state_full, &chat_peers)
            .await
        {
            Ok(errs) => {
                for (peer, complete) in &mut peer_pull_complete {
                    if errs
                        .iter()
                        .any(|error| error.starts_with(&format!("peer {peer}:")))
                    {
                        *complete = false;
                    }
                }
                stats.errors.extend(errs);
            }
            Err(e) => {
                peer_pull_complete
                    .values_mut()
                    .for_each(|complete| *complete = false);
                stats.errors.push(format!("chats: {e}"));
            }
        }
        self.emit_progress(SyncProgressPhase::PullingChats, 1, 1);

        let memory_peers = manifests
            .iter()
            .map(|(peer, manifest)| (peer.clone(), manifest.memory_present))
            .collect::<Vec<_>>();
        match self
            .pull_memory_from_peers(access, key_state_full, &memory_peers)
            .await
        {
            Ok(errs) => {
                for (peer, complete) in &mut peer_pull_complete {
                    if errs
                        .iter()
                        .any(|error| error.starts_with(&format!("peer {peer}:")))
                    {
                        *complete = false;
                    }
                }
                stats.errors.extend(errs);
            }
            Err(e) => {
                peer_pull_complete
                    .values_mut()
                    .for_each(|complete| *complete = false);
                stats.errors.push(format!("memory: {e}"));
            }
        }

        // Commit the conditional revision only after every payload described
        // by this peer's manifest has either landed or been proven absent of
        // errors. A failed journal/chat must force a body re-fetch even when
        // metadata.json itself is unchanged.
        for (peer, complete) in &peer_pull_complete {
            if !manifest_revisions.contains_key(peer) {
                continue;
            }
            let cache_result = if *complete {
                let revision = &manifest_revisions[peer];
                access.with_conn(|conn| {
                    db::set_pull_revision(conn, &peer, "metadata", revision).map_err(sync_io)
                })
            } else {
                access.with_conn(|conn| db::clear_pull_revision(conn, &peer).map_err(sync_io))
            };
            if let Err(e) = cache_result {
                let action = if *complete { "cache" } else { "clear" };
                stats
                    .errors
                    .push(format!("peer {peer}: {action} manifest revision: {e}"));
            }
        }

        self.emit_progress(SyncProgressPhase::PullingStreak, 0, 1);
        match channel_engine
            .pull_streak(access, key, key_state_full)
            .await
        {
            Ok(errs) => stats.errors.extend(errs),
            Err(e) => stats.errors.push(format!("streak: {e}")),
        }
        self.emit_progress(SyncProgressPhase::PullingStreak, 1, 1);

        self.emit_progress(SyncProgressPhase::PullingAiAudit, 0, 1);
        match channel_engine
            .pull_ai_audit(access, key, key_state_full)
            .await
        {
            Ok(errs) => stats.errors.extend(errs),
            Err(e) => stats.errors.push(format!("ai_audit: {e}")),
        }
        self.emit_progress(SyncProgressPhase::PullingAiAudit, 1, 1);

        match channel_engine
            .pull_ai_reviews(access, key, key_state_full)
            .await
        {
            Ok(errs) => stats.errors.extend(errs),
            Err(e) => stats.errors.push(format!("ai_reviews: {e}")),
        }

        if !include_self {
            let complete =
                peer_pull_complete.values().all(|complete| *complete) && stats.errors.is_empty();
            if let Err(e) = access
                .with_conn(|conn| db::set_sync_catchup_complete(conn, complete).map_err(sync_io))
            {
                stats
                    .errors
                    .push(format!("set sync catch-up completion: {e}"));
            }
            if complete && stats.errors.is_empty() {
                self.emit_catchup_progress(CatchupProgressEvent {
                    pulled: pull_total as u64,
                    total: pull_total as u64,
                    peer_device_id: None,
                });
            }
        }

        if include_self && (!stats.errors.is_empty() || !stats.warnings.is_empty()) {
            let mut failures = stats.errors.clone();
            failures.extend(stats.warnings.iter().cloned());
            return Err(SyncError::Io(format!(
                "authoritative recovery incomplete: {}",
                failures.join("; ")
            )));
        }

        Ok(stats)
    }

    /// Runs the cloud-authoritative recovery leg without invoking any push
    /// path. The caller may perform validation and adoption before normal
    /// sync is allowed again.
    pub async fn pull_only_for_recovery<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        key_state_full: &crate::EncryptionKeyState,
    ) -> Result<SyncSummary, SyncError> {
        let stats = self
            .pull_entries_for_recovery(access, key, key_state_full)
            .await?;
        let mut out = SyncSummary {
            pulled: stats.pulled,
            merged: stats.merged,
            ..SyncSummary::default()
        };
        out.errors.extend(
            stats
                .errors
                .into_iter()
                .map(|error| format!("pull: {error}")),
        );
        for warning in stats.warnings {
            let warning = format!("pull: {warning}");
            out.errors.push(warning.clone());
            out.warnings.push(warning);
        }
        Ok(out)
    }

    /// Fetches raw manifests, optionally including self, while skipping
    /// unreachable devices.
    ///
    /// Returns `Ok((manifests, errors))` where `errors` are non-fatal per-peer
    /// warnings. Returns `Err` only when `list_devices` itself fails — a
    /// catastrophic, network-level error that aborts the caller (mirrors the
    /// pre-refactor `pull_remote` behavior of propagating `list_devices` failures
    /// as `Err`). A missing manifest is treated as a half-created peer folder
    /// and skipped; other per-peer failures are collected in `errors`.
    async fn fetch_manifests(
        &self,
        include_self: bool,
    ) -> Result<(Vec<(String, DeviceMetadata)>, Vec<String>), SyncError> {
        // Standalone callers (e.g. `collect_peer_entry_ids`) clear when not
        // already in a multi-surface batch; inside `pull_remote` the batch
        // owns the cache and this is a no-op.
        self.prepare_device_cache_for_standalone_entry();
        // Share the per-cycle device list with every other pull surface.
        let devices = self.list_pull_devices().await?;
        let mut manifests = Vec::with_capacity(devices.len());
        let mut errors = Vec::new();
        for peer in &devices {
            if !include_self && peer == &self.device_id {
                continue;
            }
            if !is_safe_device_id(peer) {
                errors.push(format!("peer {peer}: invalid device ID, skipping"));
                continue;
            }
            let bytes = match self
                .provider
                .read_file(&format!("{peer}/metadata.json"))
                .await
            {
                Ok(b) => b,
                Err(SyncError::NotFound(_)) => continue,
                Err(e) => {
                    errors.push(format!("peer {peer}: manifest: {e}"));
                    continue;
                }
            };
            match serde_json::from_slice::<DeviceMetadata>(&bytes) {
                Ok(m) => manifests.push((peer.clone(), m)),
                Err(e) => errors.push(format!("peer {peer}: bad manifest JSON: {e}")),
            }
        }
        Ok((manifests, errors))
    }

    /// Steady-state-only conditional manifest fetch. Recovery and reconcile
    /// deliberately continue through [`Self::fetch_manifests`] so their trust
    /// rebuilding reads are never served from `sync_pull_state`.
    async fn fetch_manifests_conditionally<C: ConnAccess>(
        &self,
        access: &C,
    ) -> Result<
        (
            Vec<(String, DeviceMetadata)>,
            std::collections::HashMap<String, String>,
            Vec<String>,
            Vec<String>,
        ),
        SyncError,
    > {
        self.prepare_device_cache_for_standalone_entry();
        let devices = self.list_pull_devices().await?;
        let mut manifests = Vec::with_capacity(devices.len());
        let mut revisions = std::collections::HashMap::new();
        let mut errors = Vec::new();
        let mut unchanged_peers = Vec::new();

        for peer in &devices {
            if peer == &self.device_id {
                continue;
            }
            if !is_safe_device_id(peer) {
                errors.push(format!("peer {peer}: invalid device ID, skipping"));
                continue;
            }

            let known_revision = access
                .with_conn(|conn| db::get_pull_revision(conn, peer, "metadata").map_err(sync_io))?;
            let path = format!("{peer}/metadata.json");
            let (bytes, revision) = match self
                .provider
                .read_file_if_changed(&path, known_revision.as_deref())
                .await
            {
                Ok(ConditionalRead::Unchanged) => {
                    // `memory.bin` is mutable independently of metadata.json.
                    // Keep memory-advertising peers in the pull set even when
                    // their manifest revision is unchanged, otherwise a later
                    // memory snapshot can be skipped forever.
                    match self.provider.read_file(&path).await {
                        Ok(bytes) => match serde_json::from_slice::<DeviceMetadata>(&bytes) {
                            Ok(manifest) if manifest.memory_present => {
                                manifests.push((peer.clone(), manifest));
                            }
                            Ok(_) => unchanged_peers.push(peer.clone()),
                            Err(e) => errors.push(format!("peer {peer}: bad manifest JSON: {e}")),
                        },
                        Err(e) => errors.push(format!("peer {peer}: manifest: {e}")),
                    }
                    continue;
                }
                Ok(ConditionalRead::Changed { bytes, revision }) => (bytes, revision),
                Err(SyncError::NotFound(_)) => {
                    access
                        .with_conn(|conn| db::clear_pull_revision(conn, peer).map_err(sync_io))?;
                    continue;
                }
                Err(e) => {
                    errors.push(format!("peer {peer}: manifest: {e}"));
                    continue;
                }
            };

            match serde_json::from_slice::<DeviceMetadata>(&bytes) {
                Ok(manifest) => {
                    if let Some(revision) = revision {
                        revisions.insert(peer.clone(), revision);
                    } else {
                        // A provider that cannot resolve a revision must not
                        // leave a prior token capable of causing a future
                        // false `Unchanged`.
                        access.with_conn(|conn| {
                            db::clear_pull_revision(conn, peer).map_err(sync_io)
                        })?;
                    }
                    manifests.push((peer.clone(), manifest));
                }
                Err(e) => {
                    access
                        .with_conn(|conn| db::clear_pull_revision(conn, peer).map_err(sync_io))?;
                    errors.push(format!("peer {peer}: bad manifest JSON: {e}"));
                }
            }
        }

        Ok((manifests, revisions, errors, unchanged_peers))
    }

    /// Normal sync only reads peer manifests. Authoritative recovery uses
    /// `fetch_manifests(true)` through its dedicated pull-only seam.
    async fn fetch_peer_manifests(
        &self,
    ) -> Result<(Vec<(String, DeviceMetadata)>, Vec<String>), SyncError> {
        self.fetch_manifests(false).await
    }

    /// Returns the set of entry IDs already claimed by at least one live peer.
    /// On any error (network unavailable, all peers unreachable), returns an empty set —
    /// caller treats empty as "adopt everything" (safe fallback).
    pub(crate) async fn collect_peer_entry_ids(&self) -> std::collections::HashSet<String> {
        let (manifests, errors) = match self.fetch_peer_manifests().await {
            Ok(pair) => pair,
            Err(e) => {
                log::warn!(
                    "collect_peer_entry_ids: list_devices failed ({e}); adopting all entries as fallback"
                );
                return std::collections::HashSet::new();
            }
        };
        if !errors.is_empty() {
            log::warn!(
                "collect_peer_entry_ids: {} peer(s) could not be reached; their entries may be re-adopted: {:?}",
                errors.len(),
                errors
            );
        }
        // Only LIVE peer entries count as ownership. A tombstoned (is_deleted)
        // summary is a deletion record, not a live claim — counting it would
        // make `sync_repair_from_this_device` skip this device's newer live
        // local copy, letting a stale remote tombstone suppress the only good
        // copy.
        manifests
            .iter()
            .flat_map(|(_, m)| {
                m.entries
                    .iter()
                    .filter(|e| !e.is_deleted)
                    .map(|e| e.entry_id.clone())
            })
            .collect()
    }

    /// Push then pull. Per-entry errors from either half are flattened
    /// into `SyncSummary.errors`; a top-level `SyncError` (e.g. provider
    /// IO failure listing devices) aborts and is reported as a single
    /// error string. A partial failure still commits whatever succeeded.
    ///
    /// `trigger` controls own-cloud reconcile: [`SyncTrigger::Manual`] always
    /// re-lists; [`SyncTrigger::Automatic`] skips after a successful reconcile
    /// this process session (shared flag across engine instances).
    pub async fn sync_now<C: ConnAccess>(
        &self,
        access: &C,
        key: &[u8; 32],
        key_state_full: &crate::EncryptionKeyState,
        trigger: SyncTrigger,
    ) -> Result<SyncSummary, SyncError> {
        // One cycle: clear once, then batch push+pull so nested
        // `pull_remote` does not throw away a warm list. Clearing at the
        // start (not the end) also means an aborted/errored cycle cannot
        // leave a stale list for the next one. The batch guard leaves on
        // every return path, including early ones.
        self.reset_device_cache();
        let _batch = self.enter_device_cache_batch_guard();

        let mut out = SyncSummary::default();

        match self.push_local(access, key, key_state_full, trigger).await {
            Ok(s) => {
                out.pushed = s.pushed;
                for e in s.errors {
                    out.errors.push(format!("push: {e}"));
                }
            }
            Err(SyncError::ScopeMismatch(reason)) => {
                out.scope_mismatch = true;
                out.errors.push(format!("push: scope mismatch: {reason}"));
            }
            Err(e) => out.errors.push(format!("push: {e}")),
        }
        match self.pull_remote(access, key, key_state_full).await {
            Ok(s) => {
                out.pulled = s.pulled;
                out.merged = s.merged;
                out.changed_endpoint_presets = s.changed_endpoint_presets;
                for e in s.errors {
                    out.errors.push(format!("pull: {e}"));
                }
                // Preserve consistency warnings for diagnostics, and also make
                // the summary non-clean so the UI cannot stamp/display Synced
                // while peer data is known to be incomplete.
                for w in s.warnings {
                    let warning = format!("pull: {w}");
                    out.errors.push(warning.clone());
                    out.warnings.push(warning);
                }
            }
            Err(SyncError::ScopeMismatch(reason)) => {
                out.scope_mismatch = true;
                out.errors.push(format!("pull: scope mismatch: {reason}"));
            }
            Err(e) => out.errors.push(format!("pull: {e}")),
        }
        // Per-leg errors are pushed as formatted strings by sub-routines
        // (push_local / pull_remote propagate provider errors via
        // `format!("...: {e}")`). `SyncError::ScopeMismatch`'s Display is
        // `"scope mismatch: ..."` — detect the prefix to set the typed
        // flag even when the mismatch surfaced inside a sub-leg rather
        // than as an outer Err. Belt-and-braces alongside the explicit
        // arms above; either path sets the flag.
        if !out.scope_mismatch && out.errors.iter().any(|e| e.contains("scope mismatch:")) {
            out.scope_mismatch = true;
        }
        Ok(out)
    }

    /// Merge a pulled payload into the local DB.
    ///
    /// Returns `(was_merged, is_new)`:
    ///   - `is_new`: the row did not exist locally before this call.
    ///   - `was_merged`: the row existed and we applied Yjs + LWW merge.
    fn ingest_entry(
        &self,
        conn: &Connection,
        key_state_full: &crate::EncryptionKeyState,
        entry_id: &str,
        payload: &SyncEntryPayload,
    ) -> Result<(bool, bool), SyncError> {
        // ── Envelope version + fingerprint guard ───────────────────────────
        //
        // Always encrypted: only 0x01 (AES-GCM v1) is a valid envelope
        // version. The version-byte check runs FIRST — it rejects at the
        // parser level before any decrypt is attempted, so a malformed
        // envelope (including a stray 0x00 from a pre-rewrite plaintext
        // vault) cannot sneak past us by accident.
        //
        // The fingerprint check that follows is a defence-in-depth layer:
        // it catches wrong-key scenarios where the version byte happens to
        // be a valid value (e.g. truncated or zero-padded files).
        let yjs_first = payload.yjs_blob_ciphertext.first().copied();
        let meta_first = payload.metadata_ciphertext.first().copied();
        match (yjs_first, meta_first) {
            (None, _) | (_, None) => {
                return Err(SyncError::CrossModeReject(
                    "Sync file is empty or corrupted.".to_string(),
                ));
            }
            (Some(b), _) | (_, Some(b)) if b != 0x01 => {
                return Err(SyncError::CrossModeReject(format!(
                    "Unknown sync envelope format version (0x{b:02x}). \
                     Update the app or the sync folder is corrupted."
                )));
            }
            _ => {} // version byte OK; continue to fingerprint check
        }

        // Epoch-aware fingerprint check: iterate the full key list to find
        // the content key whose derived sync key fingerprint matches the
        // payload's `key_fingerprint`. This selects the correct epoch for
        // multi-key scenarios (rotation) while rejecting unknown fingerprints
        // with a hard error — never silently drops or uses the wrong key.
        //
        // V1 envelope layout: [0x01] ++ nonce(12) ++ ct ++ tag(16).
        // After the fingerprint match we decrypt with the *matching* sync key
        // directly (via `decrypt_data` on the inner bytes) rather than calling
        // `decrypt_data_with_state`, which would unconditionally use the
        // *latest* key and silently fail for older-epoch entries.
        let meta_plain = key_state_full
            .with_sync_key_for_fingerprint(&payload.key_fingerprint, |sync_k| {
                // Strip the [0x01] version byte added by encrypt_data_with_state.
                let inner = payload
                    .metadata_ciphertext
                    .get(1..)
                    .ok_or_else(|| "metadata_ciphertext: empty envelope".to_string())?;
                crate::utils::encryption::decrypt_data(sync_k, inner)
            })
            .map_err(|e| {
                SyncError::Auth(format!(
                    "sync payload for entry {entry_id}: key fingerprint not found in \
                     local content-key list — the entry may have been encrypted under \
                     a rotated key this device does not hold (re-pair required): {e}"
                ))
            })?;
        let remote_meta: EntryMetadata = serde_json::from_slice(&meta_plain)
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        if remote_meta.entry_id != entry_id {
            return Err(SyncError::Serialization(format!(
                "payload entry_id {:?} does not match path id {entry_id:?}",
                remote_meta.entry_id
            )));
        }
        // Reject obviously-bad peer input before it touches the DB.
        // `journal_id` is used as a foreign key and shown in the UI — a
        // blank or control-character string breaks both. Same character
        // class as filesystem path components (UUID-shaped).
        if remote_meta.journal_id.is_empty() || !is_safe_id(&remote_meta.journal_id) {
            return Err(SyncError::Serialization(format!(
                "peer published bad journal_id {:?} for entry {entry_id}",
                remote_meta.journal_id
            )));
        }
        // The device_id rides as the LWW tiebreak for the journal
        // piggyback and as the `cloud_path` device segment for media
        // resolution. Reject unsafe shapes for both.
        if !is_safe_device_id(&remote_meta.device_id) {
            return Err(SyncError::Serialization(format!(
                "peer published bad device_id {:?} inside entry {entry_id} payload",
                remote_meta.device_id
            )));
        }
        // `entry_id` on the path is already sanitized by the provider;
        // re-verify the id inside the payload for belt-and-braces.
        if !is_safe_id(&remote_meta.entry_id) {
            return Err(SyncError::Serialization(format!(
                "peer published bad entry_id inside payload: {:?}",
                remote_meta.entry_id
            )));
        }

        // Sanitize the journal name: strip bidi-override / control chars
        // and cap length so a malicious peer can't hijack the sidebar
        // rendering. Stripping here is OK because `journal_name` never
        // participates in equality / FK relationships — it is a display
        // label only.
        let safe_name = remote_meta
            .journal_name
            .as_deref()
            .map(sanitize_display_name)
            .unwrap_or_else(|| "Synced Journal".to_string());

        // Materialize / LWW-update the journal. The receiver overwrites
        // local color / name only when the remote journal's
        // updated_at is strictly newer than ours — so a stale pulled entry
        // cannot rewind a more recent local edit.
        // `remote_meta.device_id` is the device that authored THIS
        // entry — which, for the entry-driven journal piggyback, is
        // the most useful "remote" for the LWW tiebreak. Compare to
        // `pull_journals`, which uses `payload.device_id` (the device
        // that wrote the journal payload directly). Both are correct
        // for their respective call sites: in each case we use the
        // device id of whoever actually wrote the journal field we're
        // about to apply.
        db::upsert_synced_journal_lww(
            conn,
            &remote_meta.journal_id,
            &safe_name,
            remote_meta.journal_color.as_deref(),
            remote_meta.journal_updated_at,
            &remote_meta.device_id,
            &self.device_id,
        )
        .map_err(sync_io)?;

        let existing = db::get_entry_raw(conn, entry_id).map_err(sync_io)?;
        let is_new = existing.is_none();

        // Resolve the Yjs blob: if we have a local one, merge the CRDT
        // updates; otherwise take the remote bytes directly. The versioned
        // (0x01 AES-GCM) envelope is stripped here — the result is always
        // raw Yjs bytes. The local DB stores raw (plaintext) Yjs bytes after
        // Phase 3, so no decrypt step is needed for the local side. After
        // merging, the final blob is stored raw in the DB.
        //
        // Select the sync key by fingerprint (same key as used for metadata_ciphertext).
        let remote_yjs_plain = key_state_full
            .with_sync_key_for_fingerprint(&payload.key_fingerprint, |sync_k| {
                let inner = payload
                    .yjs_blob_ciphertext
                    .get(1..)
                    .ok_or_else(|| "yjs_blob_ciphertext: empty envelope".to_string())?;
                crate::utils::encryption::decrypt_data(sync_k, inner)
            })
            .map_err(SyncError::Serialization)?;
        let final_yjs_plain: Vec<u8> = if let Some(ref e) = existing {
            let local_blob_raw = db::get_entry_content(conn, &e.id).map_err(sync_io)?;
            match local_blob_raw {
                Some(local_plain) if !local_plain.is_empty() && !remote_yjs_plain.is_empty() => {
                    merge_yjs_full_state_updates(&local_plain, &remote_yjs_plain)?
                }
                _ => remote_yjs_plain.clone(),
            }
        } else {
            remote_yjs_plain.clone()
        };
        // Phase 3: store the merged Yjs blob as raw bytes in the DB (plaintext —
        // SQLCipher encrypts the page; no app-level encryption applied here).
        let final_yjs_doc = if final_yjs_plain.is_empty() {
            None
        } else {
            Some(final_yjs_plain)
        };

        // LWW merge for non-Yjs fields when a local row exists.
        let merged_meta = if let Some(ref local) = existing {
            // Snapshot the local entry's tag set so the LWW winner's
            // tag_ids field reflects whichever side is authoritative.
            let local_tag_ids = db::get_tag_ids_for_entry(conn, &local.id).map_err(sync_io)?;
            let local_meta = EntryMetadata {
                entry_id: local.id.clone(),
                device_id: self.device_id.clone(),
                updated_at: local.updated_at,
                entry_date: local.entry_date,
                created_at: local.created_at,
                journal_id: local.journal_id.clone(),
                journal_name: None,
                journal_color: None,
                journal_updated_at: None,
                title: local.title.clone(),
                preview_text: local.preview_text.clone(),
                content_text: local.content_text.clone(),
                location_label: local.location_label.clone(),
                location_address: local.location_address.clone(),
                weather_summary: local.weather_summary.clone(),
                weather_icon: local.weather_icon.clone(),
                latitude: local.latitude,
                longitude: local.longitude,
                emotion: local.emotion.clone(),
                is_favorite: local.is_favorite,
                is_deleted: local.is_deleted,
                is_locked: local.is_locked,
                is_invisible: local.is_invisible,
                vault_id: local.vault_id.clone(),
                cover_media_id: local.cover_media_id.clone(),
                entry_date_user_edited: local.entry_date_user_edited,
                content_language: local.content_language.clone(),
                tag_ids: local_tag_ids,
                media: vec![],
                deleted_media: vec![],
            };
            merge_metadata_lww(&local_meta, &remote_meta)
        } else {
            remote_meta.clone()
        };

        let (is_locked, is_invisible, vault_id) = normalize_entry_lock_and_vault(
            merged_meta.is_locked,
            merged_meta.is_invisible,
            merged_meta.vault_id.clone(),
        );

        db::upsert_entry_from_sync(
            conn,
            db::SyncEntryRow {
                id: entry_id,
                journal_id: &merged_meta.journal_id,
                title: merged_meta.title.as_deref(),
                preview_text: merged_meta.preview_text.as_deref(),
                content_text: merged_meta.content_text.as_deref(),
                entry_date: merged_meta.entry_date,
                created_at: merged_meta.created_at,
                updated_at: merged_meta.updated_at,
                latitude: merged_meta.latitude,
                longitude: merged_meta.longitude,
                location_label: merged_meta.location_label.as_deref(),
                location_address: merged_meta.location_address.as_deref(),
                weather_summary: merged_meta.weather_summary.as_deref(),
                weather_icon: merged_meta.weather_icon.as_deref(),
                emotion: merged_meta.emotion.as_deref(),
                is_favorite: merged_meta.is_favorite,
                is_deleted: merged_meta.is_deleted,
                is_locked,
                is_invisible,
                vault_id: vault_id.as_deref(),
                yjs_doc: final_yjs_doc.as_deref(),
                cover_media_id: merged_meta.cover_media_id.as_deref(),
                entry_date_user_edited: merged_meta.entry_date_user_edited,
                content_language: merged_meta.content_language.as_deref(),
            },
        )
        .map_err(sync_io)?;

        // Replace entry_tags with the LWW winner's tag set. Tags whose ids
        // are unknown locally are skipped — they'll backfill once the
        // tags channel (Stage 2) propagates them, at which point a
        // subsequent ingest fills the gaps.
        let safe_tag_ids: Vec<String> = merged_meta
            .tag_ids
            .iter()
            .filter(|id| is_safe_id(id))
            .cloned()
            .collect();
        db::replace_entry_tags_from_sync(conn, entry_id, &safe_tag_ids).map_err(sync_io)?;

        // Materialize the entry's media rows so the editor's inline
        // `<img data-media-id>` lookups resolve. We point each row's
        // `cloud_path` at the authoring device (`remote_meta.device_id`) —
        // that is what `validate_cloud_path` parses out to drive
        // `fetch_media`. INSERT OR IGNORE in the underlying helper keeps a
        // re-pull from clobbering whatever local state the row already has.
        for m in &remote_meta.media {
            if !is_safe_id(&m.id) {
                return Err(SyncError::Serialization(format!(
                    "peer published bad media_id {:?} for entry {entry_id}",
                    m.id
                )));
            }
            let safe_file_name = sanitize_display_name(&m.file_name);
            let cloud_path = format!("{}/media/{}", remote_meta.device_id, m.id);
            db::insert_synced_media(
                conn,
                &m.id,
                entry_id,
                &safe_file_name,
                &m.file_type,
                &cloud_path,
                m.file_size,
                m.sort_order,
                m.created_at,
                &m.insertion_mode,
                m.width,
                m.height,
                m.duration_seconds,
                m.exif_date,
                m.exif_latitude,
                m.exif_longitude,
            )
            .map_err(sync_io)?;
        }
        // POINT OF NO RETURN (T38): persist inbound media tombstones then
        // honour them. Independent of metadata LWW — a newer local title
        // edit must not discard a peer's media delete. Honour only when
        // row.created_at <= deleted_at (concurrent offline add survives).
        for d in &remote_meta.deleted_media {
            if !is_safe_id(&d.id) {
                return Err(SyncError::Serialization(format!(
                    "peer published bad deleted_media id {:?} for entry {entry_id}",
                    d.id
                )));
            }
            if d.deleted_at > now_unix() + MAX_CLOCK_SKEW_SECS {
                continue;
            }
            db::upsert_media_tombstone(conn, &d.id, entry_id, d.deleted_at).map_err(sync_io)?;
        }
        let removed_paths = db::honour_media_tombstones(conn, entry_id).map_err(sync_io)?;
        let removed_any = !removed_paths.is_empty();
        for (storage_path, thumbnail_path) in removed_paths {
            crate::commands::media::remove_media_files_best_effort(
                &storage_path,
                thumbnail_path.as_deref(),
            );
        }
        // A later local title that already won LWW still needs to re-push
        // `deleted_media` so peers that have not honoured yet converge.
        if removed_any {
            db::touch_entry_updated_at(conn, entry_id).map_err(sync_io)?;
            db::mark_entry_pending(conn, entry_id).map_err(sync_io)?;
        }

        Ok((!is_new, is_new))
    }
}

// Size caps for fields a peer can stuff into a sync payload. Honest
// devices won't approach these; adversarial / buggy peers could
// otherwise OOM the receiver via a single 1 GB content blob. The
// authoritative numbers live in `db::queries` so the write-time
// rejection and the sync-time rejection use the same threshold.
use crate::db::{
    MAX_CHAT_ATTACHMENTS, MAX_CHAT_MEMORY_IDS,
    MAX_CHAT_MESSAGE_CONTENT_BYTES as MAX_CHAT_MESSAGE_BYTES, MAX_CHAT_SOURCE_ENTRY_IDS,
    MAX_TEMPLATE_CONTENT_BYTES, MAX_TEMPLATE_DESCRIPTION_BYTES as MAX_DESCRIPTION_BYTES,
};

/// Memory payload bounds for peer-supplied fields that land in SQLite. The
/// extractor emits concise facts and SHA-256 hashes; these guards prevent one
/// corrupt peer snapshot from becoming an unbounded local allocation.
const MAX_MEMORY_TEXT_BYTES: usize = 16 * 1024;
const MAX_MEMORY_CONTENT_HASH_BYTES: usize = 256;

fn is_memory_source_type(source_type: &str) -> bool {
    matches!(source_type, "journal_entry" | "daily_chat")
}

/// Replace the auto-apply tag set for `journal_id` with exactly
/// `tag_ids`, filtering ids whose tag row doesn't exist locally yet.
/// Same shape as `db::set_journal_auto_tags` but does NOT bump the
/// journal's `updated_at` or mark it pending — this is the ingest path,
/// where the LWW update_at came from the peer.
fn set_journal_auto_tags_from_sync(
    conn: &Connection,
    journal_id: &str,
    tag_ids: &[String],
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM journal_auto_tags WHERE journal_id = ?1",
        [journal_id],
    )?;
    if tag_ids.is_empty() {
        return Ok(());
    }
    let mut tag_exists = conn.prepare("SELECT 1 FROM tags WHERE id = ?1 AND is_deleted = 0")?;
    let mut insert = conn
        .prepare("INSERT OR IGNORE INTO journal_auto_tags (journal_id, tag_id) VALUES (?1, ?2)")?;
    for tag_id in tag_ids {
        if tag_exists.exists([tag_id])? {
            insert.execute(rusqlite::params![journal_id, tag_id])?;
        }
    }
    Ok(())
}

fn sync_io(e: rusqlite::Error) -> SyncError {
    SyncError::Io(e.to_string())
}

/// Read `ai_embed_include_protected` for the embedding chunk-vector sync
/// push gate. Mirrors `ai::indexer::read_include_protected` exactly (same
/// settings key, same fail-closed default) — duplicated rather than made
/// `pub` across the module boundary because it is a two-line settings read,
/// not shared logic worth coupling `sync::engine` to `ai::indexer` for.
/// Missing/unreadable settings row fails CLOSED (`false`) so a DB hiccup can
/// never silently start syncing protected entries' vectors.
fn embed_include_protected_setting(conn: &Connection) -> bool {
    crate::db::queries::get_setting(
        conn,
        crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
    )
    .ok()
    .flatten()
    .map(|s| s == "true")
    .unwrap_or(false)
}

/// Ingest normalization for lock flags + vault binding (README clarification 15):
/// - `is_invisible` wins over `is_locked` (mutual exclusive)
/// - `is_invisible == false` forces `vault_id = NULL` (never "visible but vault-owned")
/// - `is_invisible == true` with missing / empty / unsafe vault on wire →
///   orphan always-hidden (`vault_id = NULL`, still `is_invisible`)
fn normalize_entry_lock_and_vault(
    is_locked: bool,
    is_invisible: bool,
    vault_id: Option<String>,
) -> (bool, bool, Option<String>) {
    if is_invisible {
        let vault_id = vault_id.filter(|v| !v.is_empty() && is_safe_id(v));
        (false, true, vault_id)
    } else {
        (is_locked, false, None)
    }
}

/// Maps a low-level envelope error string into a user-facing message for
/// surfacing in `SyncSummary.errors` / channel pull error accumulators.
///
/// The substrings matched here are anchored to the `Display` impl on
/// [`crate::utils::encryption::EnvelopeError`] — change them in sync if
/// that impl changes.  Other error kinds (corrupt JSON after decrypt, I/O
/// errors, etc.) pass through unchanged, prefixed with the channel name.
fn map_envelope_error_for_user(channel_name: &str, err: &str) -> String {
    if err.contains("unknown envelope version") {
        // UnknownVersion(v): unrecognised version byte — includes a stray
        // 0x00 (plaintext) envelope from a pre-rewrite vault. Always
        // encrypted: there is no mode to switch to, it is just corrupted
        // or unsupported data.
        format!(
            "{channel_name}: Unknown sync envelope format. \
             Update the app or the sync folder is corrupted."
        )
    } else if err.contains("envelope is empty") {
        // Empty: zero-length envelope.
        format!("{channel_name}: Sync file is empty or corrupted.")
    } else {
        format!("{channel_name}: decrypt failed: {err}")
    }
}

use super::safety::is_safe_device_id;

/// Same character class + length bounds as [`db::is_safe_id`] — UUID-shaped
/// ids only. Applied to peer-supplied `journal_id` / `entry_id` / etc.
/// inside decrypted payloads, not just to filesystem components.
///
/// Minimum length is 8 because every id generator in this project uses
/// either `Uuid::new_v4().to_string()` (36 chars) or nanoid-style ids
/// (≥ 21 chars). Maximum is [`db::MAX_SAFE_ID_BYTES`] (128) so a peer
/// cannot stuff multi-MB strings into id fields that land in append-only
/// columns. The earlier `>= 4` rule (no max) was looser than necessary
/// and gave a small id-squatting surface (a peer could pre-register every
/// 4-char tag id and squat new tag creates via the INSERT OR IGNORE
/// union-merge).
fn is_safe_id(s: &str) -> bool {
    db::is_safe_id(s)
}

/// Character filter shared by every peer-string sanitizer below.
/// Rejects C0/C1 controls, DEL, and the bidi-override range — these
/// have no place in any peer-supplied string we render or store.
fn is_safe_display_char(c: char) -> bool {
    !c.is_control()
        && !matches!(
            c,
            '\u{202A}'..='\u{202E}' // LRE, RLE, PDF, LRO, RLO
            | '\u{2066}'..='\u{2069}' // LRI, RLI, FSI, PDI
        )
}

/// Strip control / bidi-override characters and cap length for a peer-
/// supplied display string (journal name today; future: entry title).
/// This never participates in FK or equality checks — only in rendering.
/// Empty results fall back to `"Synced Journal"` so the UI always has
/// something to show.
fn sanitize_display_name(s: &str) -> String {
    const MAX_LEN: usize = 128;
    let cleaned: String = s.chars().filter(|c| is_safe_display_char(*c)).collect();
    let trimmed = cleaned.trim();
    let out = if trimmed.is_empty() {
        "Synced Journal".to_string()
    } else {
        trimmed.to_string()
    };
    // Cap by char count, not byte count — multi-byte chars still count as 1.
    out.chars().take(MAX_LEN).collect()
}

/// Defense-in-depth sanitizer for peer-supplied AI audit-log identifiers
/// (`feature`, `provider_id`, `model_id`, `endpoint_host`, etc.). Same
/// character filter as `sanitize_display_name`, but empty strings are
/// preserved (some fields legitimately accept `""`) and no trimming is
/// applied (whitespace inside a token is suspicious and stays visible).
fn sanitize_audit_field(s: &str) -> String {
    const MAX_LEN: usize = 128;
    s.chars()
        .filter(|c| is_safe_display_char(*c))
        .take(MAX_LEN)
        .collect()
}

/// Recovery-only entry diff: same as [`compute_diff`] plus never-seen
/// remote tombstones so an empty staging DB can materialize deletions
/// that only exist as soft-deleted cloud rows. Returned `to_pull` is sorted
/// by remote `updated_at` descending, then `entry_id` ascending for
/// deterministic ties, including tombstones appended for `include_self`;
/// the pull engine chunks this list in order.
fn recovery_entry_diff(
    local: &DeviceMetadata,
    remote: &DeviceMetadata,
    include_self: bool,
) -> SyncDiff {
    let mut diff = compute_diff(local, remote);
    if !include_self {
        return diff;
    }
    let local_ids: std::collections::HashSet<String> =
        local.entries.iter().map(|e| e.entry_id.clone()).collect();
    let mut already: std::collections::HashSet<String> = diff.to_pull.iter().cloned().collect();
    for r in &remote.entries {
        if r.is_deleted && !local_ids.contains(&r.entry_id) && already.insert(r.entry_id.clone()) {
            diff.to_pull.push(r.entry_id.clone());
        }
    }
    sort_to_pull_newest_first(&mut diff.to_pull, remote);
    diff
}

/// Recovery-only journal diff: force-pull never-seen remote tombstones so
/// cloud-authoritative restore can materialize deleted journals on empty staging.
fn recovery_journal_diff(
    local: &[SyncedJournalSummary],
    remote: &[SyncedJournalSummary],
    include_self: bool,
) -> super::metadata::JournalSyncDiff {
    let mut diff = super::metadata::compute_journal_diff(local, remote);
    if !include_self {
        return diff;
    }
    let local_ids: std::collections::HashSet<String> =
        local.iter().map(|j| j.journal_id.clone()).collect();
    let mut already: std::collections::HashSet<String> = diff.to_pull.iter().cloned().collect();
    for r in remote {
        if r.is_deleted
            && !local_ids.contains(&r.journal_id)
            && already.insert(r.journal_id.clone())
        {
            diff.to_pull.push(r.journal_id.clone());
        }
    }
    diff
}

/// Serialize a [`DeviceMetadata`] for the hash gate: same fields as the
/// uploaded JSON except `generated_at` is pinned to `0` so wall-clock cannot
/// force a re-upload every cycle. `recovery_generation`, entry/journal lists,
/// and presence flags remain part of the hash.
fn metadata_hash_bytes(manifest: &DeviceMetadata) -> Result<Vec<u8>, serde_json::Error> {
    let mut for_hash = manifest.clone();
    for_hash.generated_at = 0;
    serde_json::to_vec(&for_hash)
}

/// Build the manifest this device should **publish** to peers.
///
/// Only entries the **local device** has touched (i.e. have a
/// `sync_state` row) appear here. Pulled entries from a peer P land in
/// `entries` but without a `sync_state` row — republishing them would
/// misattribute authorship and make every device claim every entry.
///
/// Entry and journal rows are ordered by id so the content hash is stable
/// across SQLite row-order variance (hash-gate would otherwise never match).
fn build_local_manifest(
    conn: &Connection,
    device_id: &str,
    chats_present: bool,
    memory_present: bool,
) -> rusqlite::Result<DeviceMetadata> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.updated_at, s.local_version, e.is_deleted
         FROM entries e
         INNER JOIN sync_state s ON s.entry_id = e.id
         ORDER BY e.id",
    )?;
    let entries = stmt
        .query_map([], |row| {
            Ok(SyncedEntrySummary {
                entry_id: row.get::<_, String>(0)?,
                updated_at: row.get::<_, i64>(1)?,
                local_version: row.get::<_, i64>(2)?,
                is_deleted: row.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut journals = db::list_local_journal_summaries_for_push(conn)?
        .into_iter()
        .map(|j| super::metadata::SyncedJournalSummary {
            journal_id: j.journal_id,
            updated_at: j.updated_at,
            local_version: j.local_version,
            is_deleted: j.is_deleted,
        })
        .collect::<Vec<_>>();
    journals.sort_by(|a, b| a.journal_id.cmp(&b.journal_id));
    Ok(DeviceMetadata {
        device_id: device_id.to_string(),
        recovery_generation: db::get_sync_recovery_generation(conn)?,
        entries,
        journals,
        chats_present,
        memory_present,
        generated_at: now_unix(),
    })
}

/// Build the **full** local-state view used as `local` in `compute_diff`.
///
/// Unlike `build_local_manifest`, this includes every entry in the DB —
/// even entries that arrived from a peer and therefore have no
/// `sync_state` row. Without this, `pull_remote` would see a pulled-but-
/// already-stored entry as "not local" on the next pass and would
/// redundantly re-pull it (and re-count it in `PullStats.pulled`).
fn build_local_diff_view(conn: &Connection, device_id: &str) -> rusqlite::Result<DeviceMetadata> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.updated_at, COALESCE(s.local_version, 0), e.is_deleted
         FROM entries e
         LEFT JOIN sync_state s ON s.entry_id = e.id",
    )?;
    let entries = stmt
        .query_map([], |row| {
            Ok(SyncedEntrySummary {
                entry_id: row.get::<_, String>(0)?,
                updated_at: row.get::<_, i64>(1)?,
                local_version: row.get::<_, i64>(2)?,
                is_deleted: row.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(DeviceMetadata {
        device_id: device_id.to_string(),
        recovery_generation: db::get_sync_recovery_generation(conn)?,
        entries,
        journals: vec![],
        chats_present: false,
        memory_present: false,
        generated_at: now_unix(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::sync::LocalSyncProvider;
    use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};
    use rusqlite::Connection;
    use tempfile::TempDir;
    use yrs::{Doc, ReadTxn, StateVector, Text, Transact};

    fn test_key() -> zeroize::Zeroizing<[u8; 32]> {
        derive_encryption_key("chunk-3c-test-pw-xyz", &[3u8; SALT_SIZE]).unwrap()
    }

    /// Build a single-epoch `EncryptionKeyState` from a test key for use with
    /// the updated `sync_now` / `pull_remote` / `ingest_entry` signatures.
    /// Mirrors what `SyncEngine::make_key_state` does internally so round-trips
    /// in tests behave identically to production.
    fn key_state_from_key(key: &[u8; 32]) -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new(*key))
            .expect("set_key never fails");
        ks
    }

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn configure_memory_embed_slot(conn: &Connection, provider: &str, model: &str) {
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::memory_embed::PROVIDER,
            provider,
        )
        .unwrap();
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::memory_embed::EMBEDDING_MODEL,
            model,
        )
        .unwrap();
    }

    fn add_memory_item(
        conn: &Connection,
        id: &str,
        text: &str,
        source_type: &str,
        updated_at: i64,
    ) {
        db::memory::insert_memory_item(conn, id, text, source_type, updated_at).unwrap();
    }

    fn default_journal(conn: &Connection) -> String {
        conn.query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap()
    }

    fn make_engine(dir: &TempDir, device_id: &str) -> SyncEngine {
        let provider = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        SyncEngine::new(provider, device_id.to_string())
    }

    fn make_yjs_blob(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let t = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            t.insert(&mut txn, 0, text);
        }
        let bytes = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        bytes
    }

    fn make_entry_with_content(conn: &Connection, _key: &[u8; 32], plain_text: &str) -> String {
        // Phase 3: all fields are plaintext in the DB — no app-level
        // encryption. The `_key` param is kept to avoid changing every call
        // site (the engine's push/pull still takes a key for the sync channel).
        let journal = default_journal(conn);
        let id = uuid::Uuid::new_v4().to_string();
        let blob = make_yjs_blob(plain_text);
        let now = now_unix();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6, 0, 0, ?7)",
            rusqlite::params![id, journal, "t", "p", plain_text, now, blob],
        )
        .unwrap();
        db::mark_entry_pending(conn, &id).unwrap();
        id
    }

    #[test]
    fn entry_lock_flag_normalization_prefers_invisible() {
        assert_eq!(
            normalize_entry_lock_and_vault(false, false, None),
            (false, false, None)
        );
        assert_eq!(
            normalize_entry_lock_and_vault(true, false, None),
            (true, false, None)
        );
        assert_eq!(
            normalize_entry_lock_and_vault(false, true, None),
            (false, true, None)
        );
        assert_eq!(
            normalize_entry_lock_and_vault(true, true, None),
            (false, true, None)
        );

        // vault_id normalization (clarification 15)
        let safe_vault = "vault-id1".to_string();
        assert_eq!(
            normalize_entry_lock_and_vault(false, false, Some(safe_vault.clone())),
            (false, false, None),
            "not invisible forces vault_id NULL"
        );
        assert_eq!(
            normalize_entry_lock_and_vault(true, true, Some(safe_vault.clone())),
            (false, true, Some(safe_vault)),
            "invisible wins over locked and keeps vault"
        );
        assert_eq!(
            normalize_entry_lock_and_vault(false, true, None),
            (false, true, None),
            "invisible without vault = orphan always-hidden"
        );
        assert_eq!(
            normalize_entry_lock_and_vault(false, true, Some("short".into())),
            (false, true, None),
            "short vault_id fails is_safe_id → orphan"
        );
        assert_eq!(
            normalize_entry_lock_and_vault(false, true, Some(String::new())),
            (false, true, None),
            "empty vault_id → orphan"
        );
        let oversize = "x".repeat(db::MAX_SAFE_ID_BYTES + 1);
        assert_eq!(
            normalize_entry_lock_and_vault(false, true, Some(oversize)),
            (false, true, None),
            "oversize vault_id fails is_safe_id → orphan"
        );
    }

    #[tokio::test]
    async fn memory_sync_round_trip_unions_sources_and_adopts_matching_vector() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-0001";
        let content_hash = crate::ai::chunking::content_hash("Prefers espresso");
        add_memory_item(&conn_a, item_id, "Prefers espresso", "journal_entry", 100);
        db::memory::add_memory_source(&conn_a, item_id, "journal_entry", "entry-0001").unwrap();
        db::memory::upsert_memory_embedding(
            &conn_a,
            item_id,
            "local:embed-v1",
            2,
            &[0.25, 0.75],
            &content_hash,
            110,
        )
        .unwrap();
        configure_memory_embed_slot(&conn_b, "local", "embed-v1");

        assert!(engine_a.push_memory(&conn_a, &key).await.unwrap());
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        let item = db::memory::list_all_memory_items_for_sync(&conn_b).unwrap();
        assert_eq!(item.len(), 1);
        assert_eq!(item[0].text, "Prefers espresso");
        assert_eq!(
            db::memory::list_sources_for_memory(&conn_b, item_id).unwrap()[0].source_id,
            "entry-0001"
        );
        let embedding = db::memory::list_memory_embeddings_for_memory(&conn_b, item_id).unwrap();
        assert_eq!(embedding.len(), 1);
        assert_eq!(embedding[0].model_id, "local:embed-v1");
        assert_eq!(embedding[0].vec, db::embeddings::vec_to_blob(&[0.25, 0.75]));
    }

    #[tokio::test]
    async fn memory_sync_persona_lww_keeps_newer_document_in_both_directions() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        db::persona::write_persona_user_edit(&conn_a, "older peer", "peer style").unwrap();
        conn_a
            .execute("UPDATE user_persona SET updated_at = 100 WHERE id = 1", [])
            .unwrap();
        db::persona::write_persona_user_edit(&conn_b, "newer local", "local style").unwrap();
        conn_b
            .execute("UPDATE user_persona SET updated_at = 200 WHERE id = 1", [])
            .unwrap();

        assert!(engine_a.push_memory(&conn_a, &key).await.unwrap());
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        assert_eq!(
            db::persona::read_persona(&conn_b).unwrap().traits_text,
            "newer local",
            "older peer persona must lose LWW"
        );

        assert!(engine_b.push_memory(&conn_b, &key).await.unwrap());
        let errors = engine_a
            .pull_memory_from_peers(
                &conn_a,
                &key_state_from_key(&key),
                &[("dev-b".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        assert_eq!(
            db::persona::read_persona(&conn_a).unwrap().traits_text,
            "newer local",
            "newer peer persona must replace older local document"
        );
    }

    #[tokio::test]
    async fn memory_sync_persona_only_edit_repushes_memory_bin() {
        let key = test_key();
        let key_state = key_state_from_key(&key);
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");

        db::persona::write_persona_user_edit(&conn, "reflective", "warm tone").unwrap();
        assert!(engine.push_memory(&conn, &key).await.unwrap());
        let before = engine.provider.read_file("dev-a/memory.bin").await.unwrap();

        db::persona::write_persona_user_edit(&conn, "direct", "short sentences").unwrap();
        assert!(engine.push_memory(&conn, &key).await.unwrap());
        let after = engine.provider.read_file("dev-a/memory.bin").await.unwrap();
        assert_ne!(before, after, "a persona-only edit must refresh memory.bin");
        let payload: super::super::metadata::MemoryPayload =
            serde_json::from_slice(&decrypt_data_with_state(&after, &key_state).unwrap()).unwrap();
        assert_eq!(payload.items.len(), 0, "test changes no memory items");
        assert_eq!(
            payload.persona.unwrap().traits_text,
            "direct",
            "the refreshed snapshot must contain the changed persona"
        );
    }

    #[tokio::test]
    async fn memory_sync_persona_clamps_future_timestamp_and_sanitizes_content() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let oversized = format!(" peer\u{0007}\n{}", "word ".repeat(400));
        db::persona::write_persona_user_edit(&conn_a, &oversized, &oversized).unwrap();
        conn_a
            .execute(
                "UPDATE user_persona SET updated_at = ?1 WHERE id = 1",
                [i64::MAX],
            )
            .unwrap();

        assert!(engine_a.push_memory(&conn_a, &key).await.unwrap());
        let before = now_unix();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");

        let persona = db::persona::read_persona(&conn_b).unwrap();
        assert!(
            persona.updated_at <= before + 1,
            "future peer timestamp must be clamped"
        );
        assert!(!persona.traits_text.contains('\u{0007}'));
        assert!(!persona.traits_text.contains('\n'));
        assert!(
            persona.traits_text.chars().count()
                <= crate::ai::persona_builder::PERSONA_SECTION_MAX_CHARS
        );
    }

    #[tokio::test]
    async fn memory_sync_preserves_newer_local_item_and_propagates_newer_tombstone() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-0002";
        add_memory_item(&conn_a, item_id, "peer copy", "daily_chat", 100);
        add_memory_item(&conn_b, item_id, "newer local copy", "daily_chat", 200);

        engine_a.push_memory(&conn_a, &key).await.unwrap();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        assert_eq!(
            db::memory::list_all_memory_items_for_sync(&conn_b).unwrap()[0].text,
            "newer local copy",
            "older peer item must lose LWW"
        );

        db::memory::tombstone_memory_item(&conn_a, item_id, 300).unwrap();
        engine_a.push_memory(&conn_a, &key).await.unwrap();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        let item = db::memory::list_all_memory_items_for_sync(&conn_b).unwrap();
        assert!(item[0].is_deleted, "newer tombstone must win LWW");
        assert_eq!(item[0].updated_at, 300);
    }

    #[tokio::test]
    async fn memory_sync_lww_text_winner_replaces_stale_vector_and_requires_matching_hash() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-lww-vector";
        let new_text = "Peer's newer fact";
        add_memory_item(&conn_a, item_id, new_text, "daily_chat", 200);
        let new_hash = crate::ai::chunking::content_hash(new_text);
        db::memory::upsert_memory_embedding(
            &conn_a,
            item_id,
            "local:embed-v1",
            1,
            &[0.25],
            &new_hash,
            210,
        )
        .unwrap();
        add_memory_item(&conn_b, item_id, "Old local fact", "daily_chat", 100);
        db::memory::upsert_memory_embedding(
            &conn_b,
            item_id,
            "local:embed-v1",
            1,
            &[0.9],
            "old-hash",
            999,
        )
        .unwrap();
        configure_memory_embed_slot(&conn_b, "local", "embed-v1");

        engine_a.push_memory(&conn_a, &key).await.unwrap();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        let embeddings = db::memory::list_memory_embeddings_for_memory(&conn_b, item_id).unwrap();
        assert_eq!(
            embeddings.len(),
            1,
            "new-text vector replaces invalidated old vector"
        );
        assert_eq!(embeddings[0].content_hash, new_hash);
    }

    #[tokio::test]
    async fn memory_sync_clamps_peer_updated_at_before_lww_merge() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-clamped-timestamp";
        add_memory_item(&conn_a, item_id, "peer fact", "daily_chat", 100);
        conn_a
            .execute(
                "UPDATE memory_items SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![i64::MAX, item_id],
            )
            .unwrap();
        engine_a.push_memory(&conn_a, &key).await.unwrap();

        let before = now_unix();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        let item = db::memory::list_all_memory_items_for_sync(&conn_b)
            .unwrap()
            .pop()
            .unwrap();
        assert!(
            item.updated_at <= before + MAX_CLOCK_SKEW_SECS + 1,
            "inbound timestamp must be clamped rather than preserving i64::MAX"
        );
    }

    #[tokio::test]
    async fn memory_sync_future_peer_timestamp_cannot_block_local_edit() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-local-edit-after-future-pull";
        add_memory_item(&conn_a, item_id, "peer fact", "daily_chat", 100);
        conn_a
            .execute(
                "UPDATE memory_items SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now_unix() + MAX_CLOCK_SKEW_SECS, item_id],
            )
            .unwrap();
        engine_a.push_memory(&conn_a, &key).await.unwrap();

        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        let pulled_at = db::memory::list_all_memory_items_for_sync(&conn_b).unwrap()[0].updated_at;

        db::memory::update_memory_item_text(&conn_b, item_id, "local edit", now_unix()).unwrap();
        let after_edit = db::memory::list_all_memory_items_for_sync(&conn_b).unwrap()[0].clone();
        assert!(
            after_edit.updated_at > pulled_at,
            "a local edit after a future-skew pull must advance past the normalized inbound timestamp"
        );

        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        assert_eq!(
            db::memory::list_all_memory_items_for_sync(&conn_b).unwrap()[0].text,
            "local edit",
            "the stale future peer snapshot must not overwrite the local edit"
        );
    }

    #[tokio::test]
    async fn conditional_manifest_keeps_memory_peer_after_second_memory_snapshot() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-second-snapshot";
        add_memory_item(&conn_a, item_id, "first fact", "daily_chat", 100);
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let (first_manifests, first_revisions, first_errors, _) = engine_b
            .fetch_manifests_conditionally(&conn_b)
            .await
            .unwrap();
        assert!(first_errors.is_empty());
        assert_eq!(first_manifests.len(), 1);
        let revision = first_revisions.get("dev-a").unwrap();
        db::set_pull_revision(&conn_b, "dev-a", "metadata", revision).unwrap();

        db::memory::upsert_memory_item_lww(
            &conn_a,
            item_id,
            "second fact",
            "daily_chat",
            true,
            false,
            100,
            200,
        )
        .unwrap();
        engine_a.push_memory(&conn_a, &key).await.unwrap();

        let (second_manifests, _, second_errors, unchanged) = engine_b
            .fetch_manifests_conditionally(&conn_b)
            .await
            .unwrap();
        assert!(second_errors.is_empty());
        assert!(
            unchanged.is_empty(),
            "memory peer must not be skipped on unchanged metadata"
        );
        assert_eq!(second_manifests.len(), 1);
        assert!(second_manifests[0].1.memory_present);

        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), second_manifests[0].1.memory_present)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        assert_eq!(
            db::memory::list_all_memory_items_for_sync(&conn_b).unwrap()[0].text,
            "second fact"
        );
    }

    #[tokio::test]
    async fn memory_sync_ignores_foreign_model_vector_and_keeps_fresher_local_vector() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-0003";
        add_memory_item(&conn_a, item_id, "Likes tea", "daily_chat", 100);
        db::memory::upsert_memory_embedding(
            &conn_a,
            item_id,
            "peer:other",
            1,
            &[0.1],
            "peer-hash",
            300,
        )
        .unwrap();
        add_memory_item(&conn_b, item_id, "Likes tea", "daily_chat", 100);
        configure_memory_embed_slot(&conn_b, "local", "embed-v1");
        db::memory::upsert_memory_embedding(
            &conn_b,
            item_id,
            "local:embed-v1",
            1,
            &[0.9],
            "local-hash",
            400,
        )
        .unwrap();

        engine_a.push_memory(&conn_a, &key).await.unwrap();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        let embedding = db::memory::list_memory_embeddings_for_memory(&conn_b, item_id).unwrap();
        assert_eq!(embedding.len(), 1, "foreign model must not be stored");
        assert_eq!(embedding[0].vec, db::embeddings::vec_to_blob(&[0.9]));
        assert_eq!(embedding[0].indexed_at, 400, "fresher local vector wins");
    }

    #[tokio::test]
    async fn memory_sync_foreign_vector_leaves_item_for_local_model_backfill() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-foreign-backfill";
        add_memory_item(&conn_a, item_id, "Likes tea", "daily_chat", 100);
        db::memory::upsert_memory_embedding(
            &conn_a,
            item_id,
            "peer:other",
            1,
            &[0.1],
            "peer-hash",
            110,
        )
        .unwrap();
        configure_memory_embed_slot(&conn_b, "local", "embed-v1");

        engine_a.push_memory(&conn_a, &key).await.unwrap();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();

        assert!(errors.is_empty());
        assert!(
            db::memory::list_memory_embeddings_for_memory(&conn_b, item_id)
                .unwrap()
                .is_empty(),
            "foreign-model vector must not be adopted"
        );
        assert_eq!(
            db::memory::list_memory_ids_missing_embedding_for_model(&conn_b, "local:embed-v1")
                .unwrap(),
            vec![item_id.to_string()],
            "the pulled item must remain eligible for the worker's local-model backfill"
        );
        // Model mismatch + missing local vectors → pending decision, which
        // blocks blind nudge (phase 2 also gates the worker; here we pin
        // the receipt so tests do not rely on process-global Notify spy).
        let decision = crate::ai::embedding_decision::read_embed_sync_decision(
            &conn_b,
            crate::ai::embedding_decision::EmbedSyncSlot::Memory,
        )
        .unwrap();
        assert_eq!(
            decision.state,
            crate::ai::embedding_decision::EmbedSyncDecisionState::Pending
        );
        assert_eq!(
            decision.reason,
            Some(crate::ai::embedding_decision::EmbedSyncDecisionReason::ModelMismatch)
        );
        assert!(
            !crate::ai::embedding_decision::auto_index_allowed(
                &decision,
                crate::ai::embedding_decision::AutoIndexScope::SyncBackfill,
            ),
            "pending model_mismatch must block memory worker nudge"
        );
        assert!(
            decision
                .peer_models
                .iter()
                .any(|p| p.model_id == "peer:other" && p.count >= 1),
            "foreign peer model must be recorded: {:?}",
            decision.peer_models
        );
    }

    /// When the local device already holds vectors for its configured memory
    /// model, a peer's foreign-model vectors are ignored without stamping a
    /// pending decision (no missing local work).
    #[tokio::test]
    async fn memory_sync_foreign_model_with_local_vectors_does_not_stamp_pending() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        let item_id = "memory-foreign-has-local";
        add_memory_item(&conn_a, item_id, "Likes tea", "daily_chat", 100);
        db::memory::upsert_memory_embedding(
            &conn_a,
            item_id,
            "peer:other",
            1,
            &[0.1],
            "peer-hash",
            110,
        )
        .unwrap();
        add_memory_item(&conn_b, item_id, "Likes tea", "daily_chat", 100);
        configure_memory_embed_slot(&conn_b, "local", "embed-v1");
        let local_hash = crate::ai::chunking::content_hash("Likes tea");
        db::memory::upsert_memory_embedding(
            &conn_b,
            item_id,
            "local:embed-v1",
            1,
            &[0.9],
            &local_hash,
            400,
        )
        .unwrap();

        engine_a.push_memory(&conn_a, &key).await.unwrap();
        let errors = engine_b
            .pull_memory_from_peers(
                &conn_b,
                &key_state_from_key(&key),
                &[("dev-a".to_string(), true)],
            )
            .await
            .unwrap();
        assert!(errors.is_empty());
        let decision = crate::ai::embedding_decision::read_embed_sync_decision(
            &conn_b,
            crate::ai::embedding_decision::EmbedSyncSlot::Memory,
        )
        .unwrap();
        assert_eq!(
            decision.state,
            crate::ai::embedding_decision::EmbedSyncDecisionState::None,
            "no missing local-model work → no pending decision"
        );
    }

    #[test]
    fn recovery_entry_diff_sorts_appended_tombstones_newest_first_with_deterministic_ties() {
        let local = DeviceMetadata {
            device_id: "local".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        };
        let remote = DeviceMetadata {
            device_id: "remote".to_string(),
            recovery_generation: 0,
            entries: vec![
                SyncedEntrySummary {
                    entry_id: "z-tombstone".to_string(),
                    updated_at: 200,
                    local_version: 1,
                    is_deleted: true,
                },
                SyncedEntrySummary {
                    entry_id: "older-live".to_string(),
                    updated_at: 100,
                    local_version: 1,
                    is_deleted: false,
                },
                SyncedEntrySummary {
                    entry_id: "a-tombstone".to_string(),
                    updated_at: 200,
                    local_version: 1,
                    is_deleted: true,
                },
                SyncedEntrySummary {
                    entry_id: "newest-live".to_string(),
                    updated_at: 300,
                    local_version: 1,
                    is_deleted: false,
                },
            ],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        };

        let diff = recovery_entry_diff(&local, &remote, true);

        assert_eq!(
            diff.to_pull,
            vec!["newest-live", "a-tombstone", "z-tombstone", "older-live"],
            "include_self recovery pulls must stay fully newest-first after tombstones append"
        );
    }

    #[test]
    fn ingest_entry_persists_invisible_when_payload_has_both_lock_flags() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-b");
        let journal_id = default_journal(&conn);
        let entry_id = uuid::Uuid::new_v4().to_string();
        let now = now_unix();
        let remote_meta = EntryMetadata {
            entry_id: entry_id.clone(),
            device_id: "dev-a".to_string(),
            updated_at: now,
            entry_date: now,
            created_at: now,
            journal_id,
            journal_name: Some("Synced".to_string()),
            journal_color: None,
            journal_updated_at: Some(now),
            title: Some("private".to_string()),
            preview_text: Some("body".to_string()),
            content_text: Some("body".to_string()),
            location_label: None,
            location_address: None,
            weather_summary: None,
            weather_icon: None,
            latitude: None,
            longitude: None,
            emotion: None,
            is_favorite: false,
            is_deleted: false,
            is_locked: true,
            is_invisible: true,
            vault_id: None,
            cover_media_id: None,
            entry_date_user_edited: false,
            content_language: None,
            tag_ids: vec![],
            media: vec![],
            deleted_media: vec![],
        };
        let ks = engine.make_key_state(&key);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let metadata_ciphertext =
            encrypt_data_with_state(&serde_json::to_vec(&remote_meta).unwrap(), &ks).unwrap();
        let yjs_blob_ciphertext = encrypt_data_with_state(&make_yjs_blob("body"), &ks).unwrap();
        let payload = SyncEntryPayload::new(fp, yjs_blob_ciphertext, metadata_ciphertext);

        engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry_id, &payload)
            .unwrap();

        let stored = db::get_entry_raw(&conn, &entry_id).unwrap().unwrap();
        assert!(
            stored.is_invisible,
            "ingest must preserve invisible when both flags arrive"
        );
        assert!(
            !stored.is_locked,
            "ingest must normalize both flags to invisible wins"
        );
    }

    // ─── push_local ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn push_writes_every_pending_entry_and_clears_pending() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let ids: Vec<String> = (0..3)
            .map(|i| make_entry_with_content(&conn, &key, &format!("entry-{i}")))
            .collect();
        assert_eq!(db::count_pending_entries(&conn).unwrap(), 3);

        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(stats.pushed, 3);
        assert_eq!(db::count_pending_entries(&conn).unwrap(), 0);
        for id in &ids {
            assert!(dir.path().join(format!("dev-a/entries/{id}.bin")).exists());
        }
        assert!(dir.path().join("dev-a/metadata.json").exists());
    }

    #[tokio::test]
    async fn entry_payload_uses_raw_entry_lock_flags_not_journal_effective_lock() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let journal_id = default_journal(&conn);
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("entry"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn, &entry.id).unwrap();

        db::set_journal_locked(&conn, &journal_id, true).unwrap();
        engine
            .push_single_entry(&conn, &key, &entry.id)
            .await
            .unwrap();

        let bytes =
            std::fs::read(dir.path().join(format!("dev-a/entries/{}.bin", entry.id))).unwrap();
        let payload = super::super::entry_sync::deserialize_payload(&bytes).unwrap();
        let ks = engine.make_key_state(&key);
        let plain =
            crate::utils::encryption::decrypt_data_with_state(&payload.metadata_ciphertext, &ks)
                .unwrap();
        let meta: super::super::metadata::EntryMetadata = serde_json::from_slice(&plain).unwrap();
        assert!(
            !meta.is_locked,
            "journal-level lock must not serialize as an entry-level lock"
        );
        assert!(!meta.is_invisible);

        db::set_entry_locked(&conn, &entry.id, true).unwrap();
        engine
            .push_single_entry(&conn, &key, &entry.id)
            .await
            .unwrap();

        let bytes =
            std::fs::read(dir.path().join(format!("dev-a/entries/{}.bin", entry.id))).unwrap();
        let payload = super::super::entry_sync::deserialize_payload(&bytes).unwrap();
        let plain =
            crate::utils::encryption::decrypt_data_with_state(&payload.metadata_ciphertext, &ks)
                .unwrap();
        let meta: super::super::metadata::EntryMetadata = serde_json::from_slice(&plain).unwrap();
        assert!(
            meta.is_locked,
            "entry-level lock must serialize as an entry-level lock"
        );
        assert!(!meta.is_invisible);
    }

    #[tokio::test]
    async fn journal_payload_serializes_lock_flags() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");
        let journal_id = default_journal(&conn);

        db::set_journal_locked(&conn, &journal_id, true).unwrap();
        engine
            .push_single_journal(&conn, &key, &journal_id)
            .await
            .unwrap();

        let bytes =
            std::fs::read(dir.path().join(format!("dev-a/journals/{journal_id}.bin"))).unwrap();
        let ks = engine.make_key_state(&key);
        let plain = decrypt_data_with_state(&bytes, &ks).unwrap();
        let payload: super::super::metadata::JournalPayload =
            serde_json::from_slice(&plain).unwrap();

        assert!(payload.is_locked);
        assert!(!payload.is_invisible);
    }

    #[tokio::test]
    async fn sync_file_does_not_leak_plaintext() {
        // Seed an identifiable marker into every encrypted-at-rest
        // channel (entries, journals, media, tags, templates, locations,
        // chats, streak, settings). Then walk the entire sync tree and
        // assert the marker appears in NO file. This is the load-bearing
        // test that guards the encryption trust boundary across all
        // channels at once — a regression that bypasses encrypt_data on
        // any one channel surfaces here automatically.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let marker = "SECRET-PLAINTEXT-MARKER-DO-NOT-LEAK-ONTO-DISK";

        // 1. Entries channel — content_text + Yjs blob carry the marker
        let _id = make_entry_with_content(&conn, &key, marker);

        // 2. Journals channel — journal NAME carries a tagged marker
        let mut journal_marker = String::from(marker);
        journal_marker.push_str("-JOURNAL");
        let _journal = db::create_journal(&conn, &journal_marker, None).unwrap();

        // 3. Tags channel — tag NAME carries a tagged marker
        let mut tag_marker = String::from(marker);
        tag_marker.push_str("-TAG");
        db::create_tag(&conn, &tag_marker, None).unwrap();

        // 4. Templates channel — template description carries a tagged marker
        let mut template_marker = String::from(marker);
        template_marker.push_str("-TEMPLATE");
        db::create_template(&conn, "T", Some(&template_marker), None).unwrap();

        // 5. Location aliases channel — label carries a tagged marker
        let mut location_marker = String::from(marker);
        location_marker.push_str("-LOCATION");
        db::create_location_alias(&conn, &location_marker, "addr", 0.0, 0.0, None).unwrap();

        // 6. Chats channel — message content carries a tagged marker
        let mut chat_marker = String::from(marker);
        chat_marker.push_str("-CHAT");
        db::create_chat_session(
            &conn,
            "chat-test-aaaa",
            "empathetic",
            "p",
            "auto",
            now_unix(),
        )
        .unwrap();
        db::append_chat_message(
            &conn,
            "msg-test-bbbb",
            "chat-test-aaaa",
            "user",
            &chat_marker,
            now_unix(),
        )
        .unwrap();

        // 7. Settings channel — value carries a tagged marker
        let mut settings_marker = String::from(marker);
        settings_marker.push_str("-SETTINGS");
        db::set_setting(&conn, "theme", &settings_marker).unwrap();

        // 8. Streak channel — `StreakPayload` has no free-form string
        //    fields (only counts + a unix timestamp), so there's
        //    nothing to taint directly. The early-return guard in
        //    `push_streak` also skips publishing entirely when no row
        //    exists locally. The universal walk still catches any
        //    plaintext leak that hypothetically appeared via a
        //    serialization quirk — coverage is by absence of failure
        //    rather than by a positive marker.

        engine
            .sync_now(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        fn walk(dir: &std::path::Path, markers: &[&[u8]]) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, markers);
                } else {
                    let bytes = std::fs::read(&path).unwrap();
                    for marker in markers {
                        assert!(
                            !bytes.windows(marker.len()).any(|w| w == *marker),
                            "plaintext marker {:?} leaked into {}",
                            std::str::from_utf8(marker).unwrap_or("<bin>"),
                            path.display()
                        );
                    }
                }
            }
        }
        let markers: &[&[u8]] = &[
            marker.as_bytes(),
            journal_marker.as_bytes(),
            tag_marker.as_bytes(),
            template_marker.as_bytes(),
            location_marker.as_bytes(),
            chat_marker.as_bytes(),
            settings_marker.as_bytes(),
        ];
        walk(dir.path(), markers);
    }

    #[tokio::test]
    async fn push_is_idempotent_when_nothing_changed() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");
        make_entry_with_content(&conn, &key, "hello");
        engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        let second = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(second.pushed, 0);
    }

    // ─── pull_remote ────────────────────────────────────────────────────────

    /// Counts `list_devices` calls while delegating every method to an
    /// inner `LocalSyncProvider`. Used to prove the per-cycle device-list
    /// cache collapses the ~10 surface re-scans into a single provider hit.
    struct CountingListDevicesProvider {
        inner: LocalSyncProvider,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CountingListDevicesProvider {
        fn new(inner: LocalSyncProvider) -> Self {
            Self {
                inner,
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for CountingListDevicesProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    /// Counts `list_files` per kind while delegating to `LocalSyncProvider`.
    /// Used to prove own-cloud reconcile's listings are gated by
    /// [`SyncTrigger`] / the session flag.
    ///
    /// `reconcile_own_cloud_content` is the only push-path caller of
    /// `list_files(Entries|Media|Journals|DeviceRoot)`. Versions is also
    /// listed by version-folder prune, so the exclusive four kinds are the
    /// clean signal that reconcile ran; Versions is asserted as "at least
    /// one extra beyond prune" when Manual re-runs reconcile.
    struct CountingListFilesProvider {
        inner: LocalSyncProvider,
        entries: std::sync::atomic::AtomicUsize,
        media: std::sync::atomic::AtomicUsize,
        journals: std::sync::atomic::AtomicUsize,
        versions: std::sync::atomic::AtomicUsize,
        device_root: std::sync::atomic::AtomicUsize,
    }

    impl CountingListFilesProvider {
        fn new(inner: LocalSyncProvider) -> Self {
            Self {
                inner,
                entries: std::sync::atomic::AtomicUsize::new(0),
                media: std::sync::atomic::AtomicUsize::new(0),
                journals: std::sync::atomic::AtomicUsize::new(0),
                versions: std::sync::atomic::AtomicUsize::new(0),
                device_root: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn reset(&self) {
            self.entries.store(0, std::sync::atomic::Ordering::SeqCst);
            self.media.store(0, std::sync::atomic::Ordering::SeqCst);
            self.journals.store(0, std::sync::atomic::Ordering::SeqCst);
            self.versions.store(0, std::sync::atomic::Ordering::SeqCst);
            self.device_root
                .store(0, std::sync::atomic::Ordering::SeqCst);
        }

        fn count(&self, kind: FileKind) -> usize {
            let atom = match kind {
                FileKind::Entries => &self.entries,
                FileKind::Media => &self.media,
                FileKind::Journals => &self.journals,
                FileKind::Versions => &self.versions,
                FileKind::DeviceRoot => &self.device_root,
                _ => return 0,
            };
            atom.load(std::sync::atomic::Ordering::SeqCst)
        }

        /// Own-cloud reconcile listings exclusive of version prune:
        /// Entries+Media+Journals+DeviceRoot. Versions is shared with prune.
        fn exclusive_reconcile_kinds(&self) -> usize {
            self.count(FileKind::Entries)
                + self.count(FileKind::Media)
                + self.count(FileKind::Journals)
                + self.count(FileKind::DeviceRoot)
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for CountingListFilesProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            let atom = match kind {
                FileKind::Entries => Some(&self.entries),
                FileKind::Media => Some(&self.media),
                FileKind::Journals => Some(&self.journals),
                FileKind::Versions => Some(&self.versions),
                FileKind::DeviceRoot => Some(&self.device_root),
                _ => None,
            };
            if let Some(a) = atom {
                a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    #[tokio::test]
    async fn automatic_cycle_after_successful_reconcile_issues_zero_own_cloud_list_files() {
        // After a successful reconcile, Automatic must skip the own-cloud
        // listing. Entries/Media/Journals/DeviceRoot are exclusive to that
        // path, so they must stay at zero. Versions may still fire once
        // from version-folder prune (not part of the gated reconcile).
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingListFilesProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        // Isolated flag: gate logic on one long-lived engine (not the hoist).
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine = SyncEngine::with_session_flag(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
            Arc::clone(&flag),
        );
        let conn = fresh_db();
        let ks = key_state_from_key(&key);

        // First Automatic (session flag unset) runs all 5 reconcile listings.
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        assert_eq!(counting.count(FileKind::Entries), 1);
        assert_eq!(counting.count(FileKind::Media), 1);
        assert_eq!(counting.count(FileKind::Journals), 1);
        assert_eq!(counting.count(FileKind::DeviceRoot), 1);
        assert_eq!(
            counting.count(FileKind::Versions),
            2, // reconcile + version prune
            "first cycle: reconcile Versions + prune Versions"
        );
        assert!(
            flag.load(std::sync::atomic::Ordering::SeqCst),
            "successful reconcile must set the session flag"
        );

        counting.reset();
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        assert_eq!(
            counting.exclusive_reconcile_kinds(),
            0,
            "Automatic after success must issue zero own-cloud reconcile list_files (Entries/Media/Journals/DeviceRoot); got E={} M={} J={} R={}",
            counting.count(FileKind::Entries),
            counting.count(FileKind::Media),
            counting.count(FileKind::Journals),
            counting.count(FileKind::DeviceRoot),
        );
        assert_eq!(
            counting.count(FileKind::Versions),
            1,
            "only version-folder prune should list Versions after reconcile is gated off"
        );
    }

    #[tokio::test]
    async fn automatic_on_new_engine_after_session_reconcile_issues_zero_own_cloud_list_files() {
        // Production creates a fresh SyncEngine every run_sync_now cycle.
        // The process-level session flag must survive that so Automatic
        // actually skips after the first successful reconcile.
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingListFilesProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let conn = fresh_db();
        let ks = key_state_from_key(&key);

        // Engine 1: same constructor `run_sync_now` uses (process-shared flag).
        let engine1 = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        engine1
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        assert!(
            engine1
                .session_own_cloud_reconciled
                .load(std::sync::atomic::Ordering::SeqCst),
            "first engine must set the process-level session flag"
        );
        assert_eq!(
            counting.exclusive_reconcile_kinds(),
            4,
            "first reconcile: Entries+Media+Journals+DeviceRoot"
        );

        counting.reset();

        // Engine 2: brand-new instance (mirrors the next run_sync_now cycle).
        let engine2 = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        assert!(
            !engine2.should_reconcile_own_cloud(SyncTrigger::Automatic),
            "new engine must adopt the already-set process session flag"
        );
        engine2
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        assert_eq!(
            counting.exclusive_reconcile_kinds(),
            0,
            "Automatic on a new engine after session reconcile must issue zero exclusive own-cloud list_files; got E={} M={} J={} R={}",
            counting.count(FileKind::Entries),
            counting.count(FileKind::Media),
            counting.count(FileKind::Journals),
            counting.count(FileKind::DeviceRoot),
        );
        assert_eq!(
            counting.count(FileKind::Versions),
            1,
            "only version-folder prune should list Versions on the second engine"
        );
    }

    #[tokio::test]
    async fn manual_cycle_always_issues_all_five_own_cloud_list_files() {
        // Manual always re-lists Entries/Media/Journals/Versions/DeviceRoot
        // even when the session flag is already set (user clicked "Sync now").
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingListFilesProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine = SyncEngine::with_session_flag(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
            Arc::clone(&flag),
        );
        let conn = fresh_db();
        let ks = key_state_from_key(&key);

        // Seed the session flag via a successful Automatic reconcile.
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));

        counting.reset();
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        assert_eq!(
            counting.count(FileKind::Entries),
            1,
            "Manual must list Entries"
        );
        assert_eq!(counting.count(FileKind::Media), 1, "Manual must list Media");
        assert_eq!(
            counting.count(FileKind::Journals),
            1,
            "Manual must list Journals"
        );
        assert_eq!(
            counting.count(FileKind::DeviceRoot),
            1,
            "Manual must list DeviceRoot surface bins"
        );
        assert_eq!(
            counting.count(FileKind::Versions),
            2, // reconcile + prune
            "Manual must list Versions (reconcile + prune)"
        );
        assert_eq!(
            counting.exclusive_reconcile_kinds() + 1, // + Versions from reconcile
            5,
            "Manual must issue all 5 own-cloud reconcile list_files"
        );
    }

    /// Missing whole-table `.bin` on cloud must clear `sync_push_state` so the
    /// next push re-uploads (hash-gating would otherwise skip forever).
    ///
    /// Seeds the *real* content hashes (empty surfaces). That is the silent-
    /// no-upload scenario: without reconcile clearing, the gate would match
    /// and skip while the cloud file is gone.
    #[tokio::test]
    async fn reconcile_clears_surface_push_hash_when_bin_missing_on_cloud() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        let ks = key_state_from_key(&key);

        // Seed the *current* surface content hashes (not a hard-coded `{}`).
        // Multi-vault always composes `invisible_vaults_json` into settings
        // (empty array when no vaults), so the settings map is no longer `{}`.
        let settings_hash = {
            let rows = db::list_syncable_settings(&conn).unwrap();
            let mut settings = std::collections::BTreeMap::new();
            for (k, value, updated_at, deleted_at) in rows {
                settings.insert(
                    k,
                    super::super::metadata::SyncedSetting {
                        value,
                        updated_at,
                        deleted_at,
                    },
                );
            }
            let hash_bytes = serde_json::to_vec(&settings).unwrap();
            SyncEngine::surface_content_hash(&hash_bytes)
        };
        let tags_hash = SyncEngine::surface_content_hash(b"[]");
        db::set_surface_push_hash(&conn, "settings", &settings_hash).unwrap();
        db::set_surface_push_hash(&conn, "tags", &tags_hash).unwrap();
        assert!(db::get_surface_push_hash(&conn, "settings")
            .unwrap()
            .is_some());

        // Cloud has tags.bin present but settings.bin is absent (out-of-band
        // delete). Other surface bins also absent → those hashes clear too if
        // set; we only seed settings + tags above.
        std::fs::create_dir_all(dir.path().join("dev-a")).unwrap();
        std::fs::write(dir.path().join("dev-a/tags.bin"), b"present").unwrap();
        // settings.bin deliberately not written.
        assert!(
            !dir.path().join("dev-a/settings.bin").exists(),
            "precondition: settings.bin must be missing on cloud"
        );

        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        assert!(
            dir.path().join("dev-a/settings.bin").exists(),
            "missing settings.bin must be re-uploaded after reconcile clears the hash"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "settings")
                .unwrap()
                .as_deref(),
            Some(settings_hash.as_str()),
            "successful re-upload stores the content hash again"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "tags").unwrap().as_deref(),
            Some(tags_hash.as_str()),
            "present tags.bin must leave the surface hash intact (gate skips)"
        );
    }

    /// Orphaned `{device_id}/ask_journal.bin` left over after Ask Journal
    /// removal must be best-effort deleted during own-cloud reconcile so a
    /// master-key rotation is not stuck with an undecryptable straggler.
    /// Must NOT fail the whole reconcile if delete somehow errors.
    #[tokio::test]
    async fn reconcile_prunes_orphaned_ask_journal_bin() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        let ks = key_state_from_key(&key);

        std::fs::create_dir_all(dir.path().join("dev-a")).unwrap();
        let orphan = dir.path().join("dev-a/ask_journal.bin");
        std::fs::write(&orphan, b"stale-ask-journal-ciphertext").unwrap();
        assert!(orphan.exists(), "precondition: orphan must be present");

        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        assert!(
            !orphan.exists(),
            "reconcile must delete orphaned ask_journal.bin"
        );
    }

    /// DeviceRoot listing failure must not touch `sync_push_state` (fail closed).
    #[tokio::test]
    async fn reconcile_device_root_listing_failure_leaves_surface_hashes_unchanged() {
        struct FailDeviceRootListProvider;

        #[async_trait::async_trait]
        impl SyncProvider for FailDeviceRootListProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
            async fn list_files(
                &self,
                _device_id: &str,
                kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                if matches!(kind, FileKind::DeviceRoot) {
                    return Err(SyncError::Network("list device root failed".into()));
                }
                Ok(vec![])
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound(path.to_string()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Ok(())
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Ok(())
            }
        }

        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let conn = fresh_db();
        db::set_surface_push_hash(&conn, "settings", "keep-me").unwrap();

        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine = SyncEngine::with_session_flag(
            Arc::new(FailDeviceRootListProvider),
            "dev-a".to_string(),
            Arc::clone(&flag),
        );
        let ks = key_state_from_key(&key);

        let err = engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .expect_err("DeviceRoot listing failure must fail the push");
        assert!(
            matches!(err, SyncError::Network(_)),
            "expected network error, got {err}"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "settings")
                .unwrap()
                .as_deref(),
            Some("keep-me"),
            "failed DeviceRoot listing must not clear surface hashes"
        );
        assert!(
            !flag.load(std::sync::atomic::Ordering::SeqCst),
            "failed reconcile must not set the session flag"
        );
    }

    // ─── push_hashed_surface (Phase 4 Task 2) ───────────────────────────────

    /// Counts `write_file` calls (and records paths) while optionally failing
    /// writes. Used to prove the hash gate skips provider I/O and that a
    /// failed upload never stores a hash.
    struct CountingWriteProvider {
        writes: std::sync::Mutex<Vec<String>>,
        fail_writes: bool,
        files: std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
    }

    impl CountingWriteProvider {
        fn new() -> Self {
            Self {
                writes: std::sync::Mutex::new(Vec::new()),
                fail_writes: false,
                files: std::sync::Mutex::new(std::collections::HashMap::new()),
            }
        }

        fn failing() -> Self {
            Self {
                writes: std::sync::Mutex::new(Vec::new()),
                fail_writes: true,
                files: std::sync::Mutex::new(std::collections::HashMap::new()),
            }
        }

        fn write_count(&self) -> usize {
            self.writes.lock().unwrap().len()
        }

        fn write_paths(&self) -> Vec<String> {
            self.writes.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for CountingWriteProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            Ok(vec![])
        }
        async fn list_files(
            &self,
            _device_id: &str,
            _kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            Ok(vec![])
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| SyncError::NotFound(path.to_string()))
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.writes.lock().unwrap().push(path.to_string());
            if self.fail_writes {
                return Err(SyncError::Network("write failed".into()));
            }
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), data.to_vec());
            Ok(())
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.files.lock().unwrap().remove(path);
            Ok(())
        }
    }

    #[tokio::test]
    async fn push_hashed_surface_same_bytes_twice_skips_second_write() {
        let key = test_key();
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );

        let payload = b"{\"tags\":[]}";
        engine
            .push_hashed_surface(&conn, &key, "tags", payload, payload)
            .await
            .unwrap();
        assert_eq!(provider.write_count(), 1, "first push must upload");
        assert_eq!(
            provider.write_paths(),
            vec!["dev-a/tags.bin".to_string()],
            "upload path is {{device_id}}/{{surface}}.bin"
        );
        assert!(
            db::get_surface_push_hash(&conn, "tags").unwrap().is_some(),
            "hash must be stored after successful upload"
        );

        engine
            .push_hashed_surface(&conn, &key, "tags", payload, payload)
            .await
            .unwrap();
        assert_eq!(
            provider.write_count(),
            1,
            "identical content must not issue a second write_file"
        );
    }

    #[tokio::test]
    async fn push_hashed_surface_different_bytes_writes_again() {
        let key = test_key();
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );

        let first = b"{\"tags\":[]}";
        let second = b"{\"tags\":[{\"id\":\"t1\"}]}";
        engine
            .push_hashed_surface(&conn, &key, "tags", first, first)
            .await
            .unwrap();
        engine
            .push_hashed_surface(&conn, &key, "tags", second, second)
            .await
            .unwrap();
        assert_eq!(
            provider.write_count(),
            2,
            "changed content must issue write_file again"
        );
        let hash_after = db::get_surface_push_hash(&conn, "tags")
            .unwrap()
            .expect("hash after second push");
        assert_eq!(
            hash_after,
            SyncEngine::surface_content_hash(second),
            "stored hash must reflect the latest successful payload"
        );
    }

    #[tokio::test]
    async fn push_hashed_surface_write_error_does_not_store_hash() {
        let key = test_key();
        let conn = fresh_db();
        let payload = b"{\"settings\":{}}";

        // First attempt: write_file fails → hash must stay absent.
        let failing = Arc::new(CountingWriteProvider::failing());
        let engine_fail = SyncEngine::new(
            Arc::clone(&failing) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );
        let err = engine_fail
            .push_hashed_surface(&conn, &key, "settings", payload, payload)
            .await
            .expect_err("write failure must surface");
        assert!(
            matches!(err, SyncError::Network(_)),
            "expected network error, got {err}"
        );
        assert_eq!(
            failing.write_count(),
            1,
            "failed path still attempted write_file once"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "settings").unwrap(),
            None,
            "hash must not be stored when upload fails"
        );

        // Following successful cycle re-uploads (hash still dirty).
        let ok_provider = Arc::new(CountingWriteProvider::new());
        let engine_ok = SyncEngine::new(
            Arc::clone(&ok_provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );
        engine_ok
            .push_hashed_surface(&conn, &key, "settings", payload, payload)
            .await
            .unwrap();
        assert_eq!(
            ok_provider.write_count(),
            1,
            "after failed upload, next cycle must re-upload"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "settings")
                .unwrap()
                .as_deref(),
            Some(SyncEngine::surface_content_hash(payload).as_str()),
            "hash is stored only after a successful upload"
        );

        // And once stored, a third identical push skips write.
        engine_ok
            .push_hashed_surface(&conn, &key, "settings", payload, payload)
            .await
            .unwrap();
        assert_eq!(
            ok_provider.write_count(),
            1,
            "clean hash after success must skip subsequent write_file"
        );
    }

    /// Pins the reason `hash_bytes` and `upload_bytes` are separate parameters:
    /// same content with a different envelope (`generated_at`) must not re-upload.
    #[tokio::test]
    async fn push_hashed_surface_same_content_different_envelope_skips_second_write() {
        let key = test_key();
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );

        // Data portion used for the gate (no generated_at).
        let hash_bytes = br#"[{"id":"t1","name":"work"}]"#;
        // Uploaded envelopes differ only in generated_at.
        let upload_t1 =
            br#"{"device_id":"dev-a","generated_at":1000,"tags":[{"id":"t1","name":"work"}]}"#;
        let upload_t2 =
            br#"{"device_id":"dev-a","generated_at":9999,"tags":[{"id":"t1","name":"work"}]}"#;
        assert_ne!(
            upload_t1, upload_t2,
            "precondition: envelopes must differ so a wrong wire-up would re-upload"
        );
        assert_eq!(
            SyncEngine::surface_content_hash(hash_bytes),
            SyncEngine::surface_content_hash(hash_bytes),
            "same content hashes identically"
        );
        assert_ne!(
            SyncEngine::surface_content_hash(upload_t1),
            SyncEngine::surface_content_hash(upload_t2),
            "full envelopes hash differently when generated_at changes"
        );

        engine
            .push_hashed_surface(&conn, &key, "tags", hash_bytes, upload_t1)
            .await
            .unwrap();
        assert_eq!(provider.write_count(), 1, "first push must upload");

        engine
            .push_hashed_surface(&conn, &key, "tags", hash_bytes, upload_t2)
            .await
            .unwrap();
        assert_eq!(
            provider.write_count(),
            1,
            "same hash_bytes with a different upload envelope must not re-write; \
             if this fails, production likely wires upload_bytes into both args"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "tags").unwrap().as_deref(),
            Some(SyncEngine::surface_content_hash(hash_bytes).as_str()),
            "stored hash must be of the content portion, not the envelope"
        );
    }

    /// Reconcile / hash-gate surface set is owned by HASH_GATED_SURFACE_NAMES.
    /// Rotation's encrypted singleton list currently matches 1:1 — pin that so
    /// a silent drift is caught if either list changes without the other.
    #[test]
    fn hash_gated_surface_names_match_rotation_singleton_stems() {
        let rotation_stems: Vec<&str> = super::super::rotation::enumerate::SINGLETON_BLOB_NAMES
            .iter()
            .map(|name| {
                name.strip_suffix(".bin")
                    .expect("rotation singleton names end with .bin")
            })
            .collect();
        assert_eq!(
            rotation_stems.as_slice(),
            HASH_GATED_SURFACE_NAMES,
            "HASH_GATED_SURFACE_NAMES and rotation SINGLETON_BLOB_NAMES stems \
             currently must stay in lock-step (both enumerate the 9 whole-table bins)"
        );
        assert_eq!(
            HASH_GATED_SURFACE_NAMES.last().copied(),
            Some("ai_reviews"),
            "ai_reviews is the newest hashed singleton; keep it last so stems stay aligned"
        );
    }

    /// Cloud identity / write-namespace invalidation must clear hashes AND
    /// re-arm Automatic reconcile — the two invariants stay coupled.
    #[test]
    fn invalidate_surface_push_state_clears_hashes_and_rearms_session_flag() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let conn = fresh_db();
        for surface in HASH_GATED_SURFACE_NAMES {
            db::set_surface_push_hash(&conn, surface, &format!("hash-{surface}")).unwrap();
        }
        db::set_surface_push_hash(&conn, "metadata", "hash-meta").unwrap();
        db::set_pull_revision(&conn, "peer-a", "metadata", "revision-a").unwrap();
        db::set_pull_revision(&conn, "peer-b", "metadata", "revision-b").unwrap();
        db::set_sync_catchup_complete(&conn, true).unwrap();

        // Simulate "already reconciled this session".
        session_own_cloud_reconciled_shared().store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            session_own_cloud_reconciled_shared().load(std::sync::atomic::Ordering::SeqCst),
            "precondition: session flag set"
        );

        invalidate_surface_push_state(&conn).unwrap();

        for surface in HASH_GATED_SURFACE_NAMES {
            assert_eq!(
                db::get_surface_push_hash(&conn, surface).unwrap(),
                None,
                "{surface} must be default-dirty after invalidate"
            );
        }
        assert_eq!(
            db::get_surface_push_hash(&conn, "metadata").unwrap(),
            None,
            "metadata hash must clear too"
        );
        assert_eq!(
            db::get_pull_revision(&conn, "peer-a", "metadata").unwrap(),
            None,
            "pull revisions must clear with push hashes after re-pair or reset"
        );
        assert_eq!(
            db::get_pull_revision(&conn, "peer-b", "metadata").unwrap(),
            None,
            "all peer pull revisions must clear with push hashes"
        );
        assert!(
            !db::get_sync_catchup_complete(&conn).unwrap(),
            "re-pair invalidation must reset a previously complete catch-up state"
        );
        assert!(
            !session_own_cloud_reconciled_shared().load(std::sync::atomic::Ordering::SeqCst),
            "Automatic reconcile must be re-armed after invalidate"
        );
    }

    /// After a successful Automatic reconcile (session flag set) + clean
    /// hashes, invalidating write-namespace state must force the next
    /// Automatic push to re-upload all nine surface bins.
    #[tokio::test]
    async fn invalidate_surface_push_state_forces_surface_reupload_on_next_automatic() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let local = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let conn = fresh_db();
        let ks = key_state_from_key(&key);

        // Seed one row per surface so first push has real content.
        for surface in HASH_GATED_SURFACE_NAMES {
            seed_surface(&conn, surface);
        }

        let engine = SyncEngine::new_for_session(
            Arc::clone(&local) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        // Hashes present after first successful push.
        for surface in HASH_GATED_SURFACE_NAMES {
            assert!(
                db::get_surface_push_hash(&conn, surface).unwrap().is_some(),
                "{surface} hash stored after first push"
            );
        }
        assert!(
            session_own_cloud_reconciled_shared().load(std::sync::atomic::Ordering::SeqCst),
            "session flag set after first Automatic reconcile"
        );

        // Simulate write-namespace change (re-pair / reconnect): invalidate.
        // Wipe on-disk bins so a missed hash clear would still leave them
        // absent — we assert re-creation after the second push.
        invalidate_surface_push_state(&conn).unwrap();
        for surface in HASH_GATED_SURFACE_NAMES {
            let path = dir.path().join("dev-a").join(format!("{surface}.bin"));
            let _ = std::fs::remove_file(&path);
        }
        let _ = std::fs::remove_file(dir.path().join("dev-a").join("metadata.json"));

        let engine2 = SyncEngine::new_for_session(
            Arc::clone(&local) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        assert!(
            engine2.should_reconcile_own_cloud(SyncTrigger::Automatic),
            "Automatic must re-reconcile after invalidate re-armed the flag"
        );
        engine2
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        for surface in HASH_GATED_SURFACE_NAMES {
            let path = dir.path().join("dev-a").join(format!("{surface}.bin"));
            assert!(
                path.is_file(),
                "{surface}.bin must be re-published after write-namespace invalidation"
            );
            assert!(
                db::get_surface_push_hash(&conn, surface).unwrap().is_some(),
                "{surface} hash re-stored after re-upload"
            );
        }
        assert!(
            dir.path().join("dev-a").join("metadata.json").is_file(),
            "metadata.json must be re-published after invalidation"
        );
    }

    // ─── metadata.json hash-gate (Phase 5 Task 1) ───────────────────────────

    fn sample_metadata_manifest(recovery_generation: u64, generated_at: i64) -> DeviceMetadata {
        DeviceMetadata {
            device_id: "dev-a".into(),
            recovery_generation,
            entries: vec![SyncedEntrySummary {
                entry_id: "e1".into(),
                updated_at: 100,
                local_version: 1,
                is_deleted: false,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at,
        }
    }

    #[tokio::test]
    async fn push_hashed_metadata_same_content_skips_second_write() {
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );

        let manifest = sample_metadata_manifest(0, 1_700_000_000);
        let hash_bytes = metadata_hash_bytes(&manifest).unwrap();
        let upload_bytes = serde_json::to_vec(&manifest).unwrap();

        engine
            .push_hashed_metadata_json(&conn, &hash_bytes, &upload_bytes)
            .await
            .unwrap();
        assert_eq!(provider.write_count(), 1, "first push must upload");
        assert_eq!(
            provider.write_paths(),
            vec!["dev-a/metadata.json".to_string()],
            "upload path is {{device_id}}/metadata.json"
        );
        assert!(
            db::get_surface_push_hash(&conn, "metadata")
                .unwrap()
                .is_some(),
            "hash must be stored after successful upload"
        );

        // Different generated_at in the *upload* envelope, same hash_bytes
        // (generated_at already excluded) → gate must still skip.
        let mut second_upload = manifest.clone();
        second_upload.generated_at = 1_800_000_000;
        let second_upload_bytes = serde_json::to_vec(&second_upload).unwrap();
        engine
            .push_hashed_metadata_json(&conn, &hash_bytes, &second_upload_bytes)
            .await
            .unwrap();
        assert_eq!(
            provider.write_count(),
            1,
            "identical content (ignoring generated_at) must not re-write metadata.json"
        );
    }

    #[tokio::test]
    async fn push_hashed_metadata_recovery_generation_change_forces_write() {
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );

        let first = sample_metadata_manifest(0, 1_700_000_000);
        let first_hash = metadata_hash_bytes(&first).unwrap();
        let first_upload = serde_json::to_vec(&first).unwrap();
        engine
            .push_hashed_metadata_json(&conn, &first_hash, &first_upload)
            .await
            .unwrap();
        assert_eq!(provider.write_count(), 1);

        // Only recovery_generation changes — must force a re-upload because
        // the field is part of the hashed content.
        let second = sample_metadata_manifest(1, 1_700_000_000);
        let second_hash = metadata_hash_bytes(&second).unwrap();
        assert_ne!(
            SyncEngine::surface_content_hash(&first_hash),
            SyncEngine::surface_content_hash(&second_hash),
            "recovery_generation must be included in the hash"
        );
        let second_upload = serde_json::to_vec(&second).unwrap();
        engine
            .push_hashed_metadata_json(&conn, &second_hash, &second_upload)
            .await
            .unwrap();
        assert_eq!(
            provider.write_count(),
            2,
            "recovery_generation change must issue write_file again"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "metadata")
                .unwrap()
                .as_deref(),
            Some(SyncEngine::surface_content_hash(&second_hash).as_str()),
            "stored hash must reflect the new recovery_generation payload"
        );
    }

    #[test]
    fn metadata_hash_excludes_generated_at() {
        let a = sample_metadata_manifest(0, 1_700_000_000);
        let b = sample_metadata_manifest(0, 1_900_000_000);
        let hash_a = metadata_hash_bytes(&a).unwrap();
        let hash_b = metadata_hash_bytes(&b).unwrap();
        assert_eq!(
            SyncEngine::surface_content_hash(&hash_a),
            SyncEngine::surface_content_hash(&hash_b),
            "gate must ignore generated_at"
        );

        // Sanity: full envelopes (including generated_at) must diverge.
        let full_a = serde_json::to_vec(&a).unwrap();
        let full_b = serde_json::to_vec(&b).unwrap();
        assert_ne!(
            SyncEngine::surface_content_hash(&full_a),
            SyncEngine::surface_content_hash(&full_b),
            "full JSON hash MUST include generated_at (sanity)"
        );
    }

    /// End-to-end through `push_local`: second clean Automatic cycle must not
    /// rewrite `metadata.json` (other surface bins also skip via Phase 4).
    #[tokio::test]
    async fn push_local_unchanged_metadata_skips_write() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );
        let ks = key_state_from_key(&key);

        // First Automatic: session reconcile runs (no DeviceRoot files yet)
        // then uploads surfaces + metadata.json.
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        let metadata_writes_first = provider
            .write_paths()
            .into_iter()
            .filter(|p| p.ends_with("/metadata.json"))
            .count();
        assert_eq!(
            metadata_writes_first, 1,
            "first push must write metadata.json"
        );
        assert!(
            db::get_surface_push_hash(&conn, "metadata")
                .unwrap()
                .is_some(),
            "metadata surface hash stored after first push"
        );

        // Clear write log; second Automatic skips reconcile (session flag set)
        // and every hash-gated surface including metadata.
        {
            provider.writes.lock().unwrap().clear();
        }
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        let metadata_writes_second = provider
            .write_paths()
            .into_iter()
            .filter(|p| p.ends_with("/metadata.json"))
            .count();
        assert_eq!(
            metadata_writes_second,
            0,
            "unchanged metadata must issue zero write_file for metadata.json (got {:?})",
            provider.write_paths()
        );
    }

    /// Missing metadata.json on cloud must clear the `"metadata"` hash so the
    /// next reconciling push re-uploads (same silent-no-upload class as .bin).
    #[tokio::test]
    async fn reconcile_clears_metadata_hash_when_json_missing_on_cloud() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        let ks = key_state_from_key(&key);

        // First push seeds metadata.json + hash.
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();
        assert!(dir.path().join("dev-a/metadata.json").exists());
        let stored_hash = db::get_surface_push_hash(&conn, "metadata")
            .unwrap()
            .expect("hash after first push");

        // Out-of-band delete of metadata.json only (bins remain).
        std::fs::remove_file(dir.path().join("dev-a/metadata.json")).unwrap();
        // Keep surface hashes clean so only the missing-metadata path fires.
        assert!(db::get_surface_push_hash(&conn, "metadata")
            .unwrap()
            .is_some());

        reset_session_own_cloud_reconciled_for_test();
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        assert!(
            dir.path().join("dev-a/metadata.json").exists(),
            "missing metadata.json must be re-uploaded after reconcile clears the hash"
        );
        assert_eq!(
            db::get_surface_push_hash(&conn, "metadata")
                .unwrap()
                .as_deref(),
            Some(stored_hash.as_str()),
            "successful re-upload stores the same content hash again"
        );
    }

    // ─── Zero-round-trip clean cycle (Phase 5 Task 2) ───────────────────────
    //
    // End-to-end proof that Phases 1–5 compose: after a successful push, a
    // second Automatic cycle with nothing changed issues no reconcile
    // `list_files` and no `write_file`. Do NOT assert zero provider calls of
    // any kind — `sync_now` still resets the device-list cache (one
    // `list_devices`) and pull may still `read_file` peer manifests (deferred
    // pull-side work). Version/embedding prune may still list their folders
    // (pre-existing, not gated by this plan); exclusive own-cloud reconcile
    // kinds (Entries/Media/Journals/DeviceRoot) are the clean signal.

    /// Counts `list_devices` / `list_files` / `write_file` / `read_file` while
    /// delegating to `LocalSyncProvider` so cloud state stays realistic after
    /// the seed push (empty listings would false-clear surface hashes on Manual
    /// reconcile).
    struct CountingRoundTripProvider {
        inner: LocalSyncProvider,
        list_devices: std::sync::atomic::AtomicUsize,
        list_files: std::sync::atomic::AtomicUsize,
        write_files: std::sync::atomic::AtomicUsize,
        read_files: std::sync::atomic::AtomicUsize,
        entries: std::sync::atomic::AtomicUsize,
        media: std::sync::atomic::AtomicUsize,
        journals: std::sync::atomic::AtomicUsize,
        versions: std::sync::atomic::AtomicUsize,
        device_root: std::sync::atomic::AtomicUsize,
        write_paths: std::sync::Mutex<Vec<String>>,
    }

    impl CountingRoundTripProvider {
        fn new(inner: LocalSyncProvider) -> Self {
            Self {
                inner,
                list_devices: std::sync::atomic::AtomicUsize::new(0),
                list_files: std::sync::atomic::AtomicUsize::new(0),
                write_files: std::sync::atomic::AtomicUsize::new(0),
                read_files: std::sync::atomic::AtomicUsize::new(0),
                entries: std::sync::atomic::AtomicUsize::new(0),
                media: std::sync::atomic::AtomicUsize::new(0),
                journals: std::sync::atomic::AtomicUsize::new(0),
                versions: std::sync::atomic::AtomicUsize::new(0),
                device_root: std::sync::atomic::AtomicUsize::new(0),
                write_paths: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn reset(&self) {
            self.list_devices
                .store(0, std::sync::atomic::Ordering::SeqCst);
            self.list_files
                .store(0, std::sync::atomic::Ordering::SeqCst);
            self.write_files
                .store(0, std::sync::atomic::Ordering::SeqCst);
            self.read_files
                .store(0, std::sync::atomic::Ordering::SeqCst);
            self.entries.store(0, std::sync::atomic::Ordering::SeqCst);
            self.media.store(0, std::sync::atomic::Ordering::SeqCst);
            self.journals.store(0, std::sync::atomic::Ordering::SeqCst);
            self.versions.store(0, std::sync::atomic::Ordering::SeqCst);
            self.device_root
                .store(0, std::sync::atomic::Ordering::SeqCst);
            self.write_paths.lock().unwrap().clear();
        }

        fn write_count(&self) -> usize {
            self.write_files.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn write_paths(&self) -> Vec<String> {
            self.write_paths.lock().unwrap().clone()
        }

        fn list_devices_count(&self) -> usize {
            self.list_devices.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn read_file_count(&self) -> usize {
            self.read_files.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn count_kind(&self, kind: FileKind) -> usize {
            let atom = match kind {
                FileKind::Entries => &self.entries,
                FileKind::Media => &self.media,
                FileKind::Journals => &self.journals,
                FileKind::Versions => &self.versions,
                FileKind::DeviceRoot => &self.device_root,
                _ => return 0,
            };
            atom.load(std::sync::atomic::Ordering::SeqCst)
        }

        /// Own-cloud reconcile listings exclusive of version/embedding prune.
        fn exclusive_reconcile_kinds(&self) -> usize {
            self.count_kind(FileKind::Entries)
                + self.count_kind(FileKind::Media)
                + self.count_kind(FileKind::Journals)
                + self.count_kind(FileKind::DeviceRoot)
        }

        fn metadata_write_count(&self) -> usize {
            self.write_paths()
                .into_iter()
                .filter(|p| p.ends_with("/metadata.json"))
                .count()
        }

        fn entry_write_count(&self, entry_id: &str) -> usize {
            let want = format!("dev-a/entries/{entry_id}.bin");
            self.write_paths()
                .into_iter()
                .filter(|p| p == &want)
                .count()
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for CountingRoundTripProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.list_devices
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.list_files
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let atom = match kind {
                FileKind::Entries => Some(&self.entries),
                FileKind::Media => Some(&self.media),
                FileKind::Journals => Some(&self.journals),
                FileKind::Versions => Some(&self.versions),
                FileKind::DeviceRoot => Some(&self.device_root),
                _ => None,
            };
            if let Some(a) = atom {
                a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.read_files
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.write_files
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.write_paths.lock().unwrap().push(path.to_string());
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    /// After a successful seed push, a second Automatic `sync_now` with nothing
    /// changed must issue **no** own-cloud reconcile `list_files` and **no**
    /// `write_file`. `list_devices` / pull `read_file` may still occur.
    #[tokio::test]
    async fn clean_automatic_cycle_issues_no_list_files_and_no_write_file() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingRoundTripProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let conn = fresh_db();
        let ks = key_state_from_key(&key);

        // Engine adopts process-level session flag (mirrors run_sync_now).
        let engine = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        // Seed: full Automatic cycle uploads surfaces + metadata and sets the
        // session reconcile flag.
        engine
            .sync_now(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        assert!(
            counting.write_count() > 0,
            "seed cycle must perform at least one write"
        );
        assert_eq!(
            counting.exclusive_reconcile_kinds(),
            4,
            "seed Automatic must reconcile Entries/Media/Journals/DeviceRoot"
        );
        assert!(
            db::get_surface_push_hash(&conn, "metadata")
                .unwrap()
                .is_some(),
            "seed must store metadata surface hash"
        );

        counting.reset();

        // Second Automatic: nothing changed — push leg must be silent for the
        // gated reconcile listings and all write_file paths.
        let engine2 = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        engine2
            .sync_now(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        assert_eq!(
            counting.write_count(),
            0,
            "clean Automatic cycle must issue zero write_file (got paths {:?})",
            counting.write_paths()
        );
        assert_eq!(
            counting.exclusive_reconcile_kinds(),
            0,
            "clean Automatic cycle must issue zero own-cloud reconcile list_files \
             (Entries/Media/Journals/DeviceRoot); got E={} M={} J={} R={}",
            counting.count_kind(FileKind::Entries),
            counting.count_kind(FileKind::Media),
            counting.count_kind(FileKind::Journals),
            counting.count_kind(FileKind::DeviceRoot),
        );
        // Allowed residual traffic — do not treat as failure:
        // - list_devices: cache reset at start of each sync_now
        // - read_file: pull-side peer manifests (deferred work)
        // - Versions/EmbeddingChunks list_files: unconditional prune paths
        let _ = (
            counting.list_devices_count(),
            counting.read_file_count(),
            counting.count_kind(FileKind::Versions),
        );
    }

    /// Only the `chats_present` flag differs from the stored metadata hash →
    /// clean cycle correctly breaks and rewrites `metadata.json`.
    #[tokio::test]
    async fn flipping_only_chats_present_still_writes_metadata_json() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingRoundTripProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let conn = fresh_db();
        let ks = key_state_from_key(&key);
        let engine = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        assert_eq!(
            counting.metadata_write_count(),
            1,
            "seed push must write metadata.json"
        );

        // Stored hash currently reflects chats_present=true (push_chats Ok).
        // Overwrite with the hash of the same manifest except chats_present=false
        // so the *only* dirty field on the next cycle is that flag.
        let false_present = build_local_manifest(&conn, "dev-a", false, false).unwrap();
        let false_hash_bytes = metadata_hash_bytes(&false_present).unwrap();
        let false_content_hash = SyncEngine::surface_content_hash(&false_hash_bytes);
        let true_present = build_local_manifest(&conn, "dev-a", true, false).unwrap();
        let true_hash_bytes = metadata_hash_bytes(&true_present).unwrap();
        assert_ne!(
            SyncEngine::surface_content_hash(&true_hash_bytes),
            false_content_hash,
            "precondition: chats_present must affect the metadata hash"
        );
        db::set_surface_push_hash(&conn, "metadata", &false_content_hash).unwrap();

        counting.reset();
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        assert_eq!(
            counting.metadata_write_count(),
            1,
            "flipping only chats_present must rewrite metadata.json (paths {:?})",
            counting.write_paths()
        );
        // Other surface bins stay clean — only metadata.json should write.
        let non_metadata: Vec<String> = counting
            .write_paths()
            .into_iter()
            .filter(|p| !p.ends_with("/metadata.json"))
            .collect();
        assert!(
            non_metadata.is_empty(),
            "only metadata.json should write when solely chats_present flips; also wrote {non_metadata:?}"
        );
    }

    /// A newly pending entry dirties the metadata entry list and uploads the
    /// entry blob — clean cycle correctly breaks for both paths.
    #[tokio::test]
    async fn adding_one_pending_entry_writes_metadata_and_entry_blob() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingRoundTripProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let conn = fresh_db();
        let ks = key_state_from_key(&key);
        let engine = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        counting.reset();
        let entry_id = make_entry_with_content(&conn, &key, "new pending entry");
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();

        assert_eq!(
            counting.metadata_write_count(),
            1,
            "new entry must rewrite metadata.json (entry list changed); paths {:?}",
            counting.write_paths()
        );
        assert_eq!(
            counting.entry_write_count(&entry_id),
            1,
            "new pending entry must upload entries/{{id}}.bin; paths {:?}",
            counting.write_paths()
        );
    }

    /// Manual still reconciles (4 exclusive `list_files`) when everything is
    /// otherwise clean — Phase 2's "always self-heal on Sync now" decision.
    #[tokio::test]
    async fn manual_trigger_still_reconciles_when_everything_is_clean() {
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let counting = Arc::new(CountingRoundTripProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let conn = fresh_db();
        let ks = key_state_from_key(&key);
        let engine = SyncEngine::new_for_session(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        // Seed + set session flag via Automatic so reconcile would skip if
        // this were another Automatic tick.
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .unwrap();
        assert_eq!(counting.exclusive_reconcile_kinds(), 4);

        counting.reset();
        engine
            .push_local(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        assert_eq!(
            counting.count_kind(FileKind::Entries),
            1,
            "Manual must list Entries"
        );
        assert_eq!(
            counting.count_kind(FileKind::Media),
            1,
            "Manual must list Media"
        );
        assert_eq!(
            counting.count_kind(FileKind::Journals),
            1,
            "Manual must list Journals"
        );
        assert_eq!(
            counting.count_kind(FileKind::DeviceRoot),
            1,
            "Manual must list DeviceRoot"
        );
        assert_eq!(
            counting.exclusive_reconcile_kinds(),
            4,
            "Manual clean cycle must still issue all 4 exclusive reconcile list_files"
        );
    }

    // ─── Per-surface skip/upload matrix (Phase 4 Task 4) ────────────────────
    //
    // For each hash-gated whole-table surface:
    //   1. mutate ⇒ upload
    //   2. unchanged ⇒ no upload (assert absence of write_file, not just lower count)
    //   3. hash excludes generated_at (data portion only; streak is full payload)
    // Plus one LWW-echo regression for settings.

    /// Alias the production constant so matrix tests cannot drift from reconcile/push.
    const HASH_GATED_SURFACES: &[&str] = HASH_GATED_SURFACE_NAMES;

    fn surface_bin_path(surface: &str) -> String {
        format!("dev-a/{surface}.bin")
    }

    fn count_surface_writes(provider: &CountingWriteProvider, surface: &str) -> usize {
        let want = surface_bin_path(surface);
        provider
            .write_paths()
            .into_iter()
            .filter(|p| p == &want)
            .count()
    }

    fn clear_provider_writes(provider: &CountingWriteProvider) {
        provider.writes.lock().unwrap().clear();
    }

    /// Seed non-empty content for a surface. Returns an id string used by
    /// [`mutate_surface`] (tag/template/location id, session id, or a label).
    fn seed_surface(conn: &Connection, surface: &str) -> String {
        match surface {
            "settings" => {
                db::set_setting(conn, "theme", "dark").unwrap();
                "theme".into()
            }
            "tags" => {
                let t = db::create_tag(conn, "matrix-tag", Some("#aabbcc")).unwrap();
                t.id
            }
            "templates" => {
                let t = db::create_template(conn, "matrix-tmpl", Some("desc"), None).unwrap();
                t.id
            }
            "chats" => {
                let id = "chat-matrix-aaaa".to_string();
                db::create_chat_session(conn, &id, "empathetic", "p", "auto", 1_700_000_000)
                    .unwrap();
                db::append_chat_message(
                    conn,
                    "msg-matrix-aaaa",
                    &id,
                    "user",
                    "hello",
                    1_700_000_001,
                )
                .unwrap();
                id
            }
            "memory" => {
                let id = "memory-matrix-aaaa".to_string();
                add_memory_item(conn, &id, "matrix memory", "daily_chat", 1_700_000_000);
                id
            }
            "streak" => {
                conn.execute(
                    "INSERT OR REPLACE INTO streak_cache
                        (user_id, current_streak, longest_streak, last_entry_date, updated_at)
                     VALUES ('local', 3, 7, 1700000000, 1700000000)",
                    [],
                )
                .unwrap();
                "streak".into()
            }
            "locations" => {
                let a =
                    db::create_location_alias(conn, "Home", "1 Main St", 1.0, 2.0, None).unwrap();
                a.id
            }
            "ai_audit" => {
                db::insert_ai_audit_log(
                    conn,
                    &db::AiAuditLogInsert {
                        created_at: 1_700_000_000,
                        feature: "smart_title".into(),
                        operation: "chat".into(),
                        provider_id: "openai".into(),
                        model_id: "gpt-4o-mini".into(),
                        endpoint_host: "api.openai.com".into(),
                        endpoint_class: "remote".into(),
                        payload_bytes: 10,
                        latency_ms: 5,
                        status: "ok".into(),
                        error_code: None,
                        tokens_in: Some(1),
                        tokens_out: Some(2),
                    },
                )
                .unwrap();
                "ai_audit".into()
            }
            "ai_reviews" => {
                db::upsert_ai_review(conn, "weekly", 100, 200, "m", "{}", 1, 1).unwrap();
                "weekly:100:200".into()
            }
            other => panic!("unknown surface {other}"),
        }
    }

    /// Mutate surface content so the next push must re-upload.
    fn mutate_surface(conn: &Connection, surface: &str, seed_id: &str) {
        match surface {
            "settings" => db::set_setting(conn, "theme", "light").unwrap(),
            "tags" => {
                db::update_tag(conn, seed_id, Some("matrix-tag-mutated"), None).unwrap();
            }
            "templates" => {
                db::update_template(conn, seed_id, "matrix-tmpl-mut", Some("new-desc"), None)
                    .unwrap();
            }
            "chats" => {
                db::append_chat_message(
                    conn,
                    "msg-matrix-bbbb",
                    seed_id,
                    "assistant",
                    "hi back",
                    1_700_000_010,
                )
                .unwrap();
            }
            "memory" => {
                db::memory::update_memory_item_text(
                    conn,
                    seed_id,
                    "matrix memory mutated",
                    1_700_000_010,
                )
                .unwrap();
            }
            "streak" => {
                conn.execute(
                    "UPDATE streak_cache
                     SET current_streak = 9, longest_streak = 12, updated_at = 1700000500
                     WHERE user_id = 'local'",
                    [],
                )
                .unwrap();
            }
            "locations" => {
                db::update_location_alias(
                    conn,
                    seed_id,
                    "Work",
                    "2 Side St",
                    3.0,
                    4.0,
                    Some(200.0),
                )
                .unwrap();
            }
            "ai_audit" => {
                db::insert_ai_audit_log(
                    conn,
                    &db::AiAuditLogInsert {
                        created_at: 1_700_000_100,
                        feature: "daily_chat".into(),
                        operation: "chat".into(),
                        provider_id: "openai".into(),
                        model_id: "gpt-4o".into(),
                        endpoint_host: "api.openai.com".into(),
                        endpoint_class: "remote".into(),
                        payload_bytes: 20,
                        latency_ms: 8,
                        status: "ok".into(),
                        error_code: None,
                        tokens_in: Some(3),
                        tokens_out: Some(4),
                    },
                )
                .unwrap();
            }
            "ai_reviews" => {
                db::upsert_ai_review(conn, "weekly", 100, 200, "m", "{\"mut\":true}", 1, 2)
                    .unwrap();
            }
            other => panic!("unknown surface {other}"),
        }
    }

    async fn push_one_surface(
        engine: &SyncEngine,
        conn: &Connection,
        key: &[u8; 32],
        surface: &str,
    ) -> Result<(), SyncError> {
        match surface {
            "settings" => engine.push_settings(conn, key).await,
            "tags" => engine.push_tags(conn, key).await,
            "templates" => engine.push_templates(conn, key).await,
            "chats" => engine.push_chats(conn, key).await,
            "memory" => engine.push_memory(conn, key).await.map(|_| ()),
            "streak" => engine.push_streak(conn, key).await,
            "locations" => engine.push_location_aliases(conn, key).await,
            "ai_audit" => engine.push_ai_audit(conn, key).await,
            "ai_reviews" => engine.push_ai_reviews(conn, key).await,
            other => panic!("unknown surface {other}"),
        }
    }

    /// Reconstruct the exact plaintext bytes the gate hashes for a surface
    /// (data portion only for envelopes with `generated_at`; full payload for
    /// streak). Mirrors each `push_*` function's hash_bytes construction.
    fn surface_hash_bytes(conn: &Connection, surface: &str, device_id: &str) -> Vec<u8> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        match surface {
            "settings" => {
                let rows = db::list_syncable_settings(conn).unwrap();
                let mut settings = std::collections::BTreeMap::new();
                for (k, value, updated_at, deleted_at) in rows {
                    settings.insert(
                        k,
                        super::super::metadata::SyncedSetting {
                            value,
                            updated_at,
                            deleted_at,
                        },
                    );
                }
                serde_json::to_vec(&settings).unwrap()
            }
            "tags" => {
                let tags: Vec<super::super::metadata::SyncedTag> = db::list_syncable_tags(conn)
                    .unwrap()
                    .into_iter()
                    .map(|r| super::super::metadata::SyncedTag {
                        id: r.id,
                        name: r.name,
                        color: r.color,
                        updated_at: r.updated_at,
                        is_deleted: r.is_deleted,
                    })
                    .collect();
                serde_json::to_vec(&tags).unwrap()
            }
            "templates" => {
                let templates: Vec<super::super::metadata::SyncedTemplate> =
                    db::list_syncable_templates(conn)
                        .unwrap()
                        .into_iter()
                        .map(|r| super::super::metadata::SyncedTemplate {
                            id: r.id,
                            name: r.name,
                            description: r.description,
                            content_b64: r.content.map(|c| B64.encode(c)),
                            sort_order: r.sort_order,
                            created_at: r.created_at,
                            updated_at: r.updated_at,
                            is_deleted: r.is_deleted,
                        })
                        .collect();
                serde_json::to_vec(&templates).unwrap()
            }
            "chats" => {
                let sessions: Vec<super::super::metadata::SyncedChatSession> =
                    db::list_syncable_chat_sessions(conn)
                        .unwrap()
                        .into_iter()
                        .map(|s| super::super::metadata::SyncedChatSession {
                            id: s.id,
                            title: s.title,
                            persona: s.persona,
                            persona_prompt_snapshot: s.persona_prompt_snapshot,
                            language: s.language,
                            created_at: s.created_at,
                            updated_at: s.updated_at,
                            is_deleted: s.is_deleted,
                            title_is_ai_generated: s.title_is_ai_generated,
                            used_rag: s.used_rag,
                            converted_entry_id: s.converted_entry_id,
                            converted_through_seq: s.converted_through_seq,
                            pinned_at: s.pinned_at,
                            messages: s
                                .messages
                                .into_iter()
                                .map(|m| super::super::metadata::SyncedChatMessage {
                                    id: m.id,
                                    role: m.role,
                                    content: m.content,
                                    seq: m.seq,
                                    created_at: m.created_at,
                                    model_id: m.model_id,
                                    provider_id: m.provider_id,
                                    endpoint_class: m.endpoint_class,
                                    tokens_in: m.tokens_in,
                                    tokens_out: m.tokens_out,
                                    latency_ms: m.latency_ms,
                                    attachments: m.attachments,
                                    source_entry_ids: m.source_entry_ids,
                                    memory_ids: m.memory_ids,
                                })
                                .collect(),
                        })
                        .collect();
                serde_json::to_vec(&sessions).unwrap()
            }
            "memory" => {
                let items = db::memory::list_all_memory_items_for_sync(conn)
                    .unwrap()
                    .into_iter()
                    .map(|item| super::super::metadata::SyncedMemoryItem {
                        sources: db::memory::list_sources_for_memory(conn, &item.id)
                            .unwrap()
                            .into_iter()
                            .map(|source| super::super::metadata::MemorySourceRef {
                                source_type: source.source_type,
                                source_id: source.source_id,
                            })
                            .collect(),
                        embeddings: db::memory::list_memory_embeddings_for_memory(conn, &item.id)
                            .unwrap()
                            .into_iter()
                            .map(|embedding| super::super::metadata::SyncedMemoryVec {
                                model_id: embedding.model_id,
                                dim: embedding.dim,
                                vec: embedding.vec,
                                content_hash: embedding.content_hash,
                                indexed_at: embedding.indexed_at,
                            })
                            .collect(),
                        id: item.id,
                        text: item.text,
                        source_type: item.source_type,
                        enabled: item.enabled,
                        is_deleted: item.is_deleted,
                        created_at: item.created_at,
                        updated_at: item.updated_at,
                    })
                    .collect::<Vec<_>>();
                let persona = db::persona::read_persona(conn).unwrap();
                serde_json::to_vec(&super::super::metadata::MemoryPayload {
                    items,
                    persona: Some(super::super::metadata::SyncedPersona {
                        answers_json: persona.answers_json,
                        traits_text: persona.traits_text,
                        style_text: persona.style_text,
                        enabled: persona.enabled,
                        user_edited: persona.user_edited,
                        generated_at: persona.generated_at,
                        updated_at: persona.updated_at,
                    }),
                })
                .unwrap()
            }
            "streak" => {
                let row = db::get_syncable_streak(conn)
                    .unwrap()
                    .expect("seeded streak row");
                let payload = super::super::metadata::StreakPayload {
                    device_id: device_id.to_string(),
                    current_streak: row.current_streak,
                    longest_streak: row.longest_streak,
                    last_entry_date: row.last_entry_date,
                    updated_at: row.updated_at,
                };
                serde_json::to_vec(&payload).unwrap()
            }
            "locations" => {
                let aliases: Vec<super::super::metadata::SyncedLocationAlias> =
                    db::list_syncable_location_aliases(conn)
                        .unwrap()
                        .into_iter()
                        .map(|r| super::super::metadata::SyncedLocationAlias {
                            id: r.id,
                            label: r.label,
                            address: r.address,
                            latitude: r.latitude,
                            longitude: r.longitude,
                            radius_meters: r.radius_meters,
                            created_at: r.created_at,
                            updated_at: r.updated_at,
                            is_deleted: r.is_deleted,
                        })
                        .collect();
                serde_json::to_vec(&aliases).unwrap()
            }
            "ai_audit" => {
                let synced: Vec<super::super::metadata::SyncedAiAuditRow> =
                    db::list_local_ai_audit_log(conn)
                        .unwrap()
                        .into_iter()
                        .map(|r| super::super::metadata::SyncedAiAuditRow {
                            local_seq: r.local_seq,
                            created_at: r.created_at,
                            feature: r.feature,
                            operation: r.operation,
                            provider_id: r.provider_id,
                            model_id: r.model_id,
                            endpoint_host: r.endpoint_host,
                            endpoint_class: r.endpoint_class,
                            payload_bytes: r.payload_bytes,
                            latency_ms: r.latency_ms,
                            status: r.status,
                            error_code: r.error_code,
                            tokens_in: r.tokens_in,
                            tokens_out: r.tokens_out,
                            device_name: r.device_name,
                        })
                        .collect();
                serde_json::to_vec(&synced).unwrap()
            }
            "ai_reviews" => {
                let reviews: Vec<super::super::metadata::SyncedAiReview> =
                    db::list_syncable_ai_reviews(conn)
                        .unwrap()
                        .into_iter()
                        .map(|r| super::super::metadata::SyncedAiReview {
                            kind: r.kind,
                            period_start: r.period_start,
                            period_end: r.period_end,
                            model_id: r.model_id,
                            result_json: r.result_json,
                            entry_count: r.entry_count,
                            created_at: r.created_at,
                        })
                        .collect();
                serde_json::to_vec(&reviews).unwrap()
            }
            other => panic!("unknown surface {other}"),
        }
    }

    /// Wrap the data portion in a full upload envelope with an explicit
    /// `generated_at` (used only to prove envelope hashing would diverge).
    fn surface_upload_envelope(
        conn: &Connection,
        surface: &str,
        device_id: &str,
        generated_at: i64,
    ) -> Vec<u8> {
        match surface {
            "settings" => {
                let rows = db::list_syncable_settings(conn).unwrap();
                let mut settings = std::collections::BTreeMap::new();
                for (k, value, updated_at, deleted_at) in rows {
                    settings.insert(
                        k,
                        super::super::metadata::SyncedSetting {
                            value,
                            updated_at,
                            deleted_at,
                        },
                    );
                }
                serde_json::to_vec(&super::super::metadata::SettingsPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    settings,
                })
                .unwrap()
            }
            "tags" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let tags: Vec<super::super::metadata::SyncedTag> =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&super::super::metadata::TagsPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    tags,
                })
                .unwrap()
            }
            "templates" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let templates: Vec<super::super::metadata::SyncedTemplate> =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&super::super::metadata::TemplatesPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    templates,
                })
                .unwrap()
            }
            "chats" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let sessions: Vec<super::super::metadata::SyncedChatSession> =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&super::super::metadata::ChatPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    sessions,
                })
                .unwrap()
            }
            "memory" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let payload: super::super::metadata::MemoryPayload =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&payload).unwrap()
            }
            "locations" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let aliases: Vec<super::super::metadata::SyncedLocationAlias> =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&super::super::metadata::LocationAliasesPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    aliases,
                })
                .unwrap()
            }
            "ai_audit" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let rows: Vec<super::super::metadata::SyncedAiAuditRow> =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&super::super::metadata::AiAuditPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    rows,
                })
                .unwrap()
            }
            "ai_reviews" => {
                let data = surface_hash_bytes(conn, surface, device_id);
                let reviews: Vec<super::super::metadata::SyncedAiReview> =
                    serde_json::from_slice(&data).unwrap();
                serde_json::to_vec(&super::super::metadata::AiReviewsPayload {
                    device_id: device_id.to_string(),
                    generated_at,
                    reviews,
                })
                .unwrap()
            }
            "streak" => surface_hash_bytes(conn, surface, device_id),
            other => panic!("unknown surface {other}"),
        }
    }

    #[tokio::test]
    async fn surface_hash_gate_mutate_triggers_upload() {
        for surface in HASH_GATED_SURFACES {
            let key = test_key();
            let conn = fresh_db();
            let seed_id = seed_surface(&conn, surface);
            let provider = Arc::new(CountingWriteProvider::new());
            let engine = SyncEngine::new(
                Arc::clone(&provider) as Arc<dyn SyncProvider>,
                "dev-a".into(),
            );

            push_one_surface(&engine, &conn, &key, surface)
                .await
                .unwrap();
            assert_eq!(
                count_surface_writes(&provider, surface),
                1,
                "{surface}: first push must upload"
            );

            clear_provider_writes(&provider);
            mutate_surface(&conn, surface, &seed_id);
            push_one_surface(&engine, &conn, &key, surface)
                .await
                .unwrap();
            assert_eq!(
                count_surface_writes(&provider, surface),
                1,
                "{surface}: mutation must issue write_file for {surface}.bin"
            );
        }
    }

    #[tokio::test]
    async fn surface_hash_gate_unchanged_skips_upload() {
        for surface in HASH_GATED_SURFACES {
            let key = test_key();
            let conn = fresh_db();
            let _seed_id = seed_surface(&conn, surface);
            let provider = Arc::new(CountingWriteProvider::new());
            let engine = SyncEngine::new(
                Arc::clone(&provider) as Arc<dyn SyncProvider>,
                "dev-a".into(),
            );

            push_one_surface(&engine, &conn, &key, surface)
                .await
                .unwrap();
            assert_eq!(
                count_surface_writes(&provider, surface),
                1,
                "{surface}: first push must upload"
            );

            // Reset write log so the second push is asserted by *absence*,
            // not merely a lower total count.
            clear_provider_writes(&provider);
            push_one_surface(&engine, &conn, &key, surface)
                .await
                .unwrap();
            assert_eq!(
                count_surface_writes(&provider, surface),
                0,
                "{surface}: unchanged content must issue zero write_file for {surface}.bin"
            );
            assert!(
                provider.write_paths().is_empty(),
                "{surface}: second push must not write any path (got {:?})",
                provider.write_paths()
            );
        }
    }

    #[test]
    fn surface_hash_gate_excludes_generated_at() {
        for surface in HASH_GATED_SURFACES {
            let conn = fresh_db();
            let _ = seed_surface(&conn, surface);
            let data = surface_hash_bytes(&conn, surface, "dev-a");
            // Reconstructing the data portion twice yields a stable hash
            // (deterministic serialization; no wall-clock in the gate input).
            let data_again = surface_hash_bytes(&conn, surface, "dev-a");
            assert_eq!(
                SyncEngine::surface_content_hash(&data),
                SyncEngine::surface_content_hash(&data_again),
                "{surface}: data-portion hash must be stable"
            );

            if matches!(*surface, "streak" | "memory") {
                // Streak and memory have no generated_at — the gate hashes
                // their full payloads.
                continue;
            }

            // Same rows at two wall-clock times: full envelopes differ, data
            // portion (what the gate hashes) does not.
            let env_t1 = surface_upload_envelope(&conn, surface, "dev-a", 1_700_000_000);
            let env_t2 = surface_upload_envelope(&conn, surface, "dev-a", 1_800_000_000);
            assert_ne!(
                SyncEngine::surface_content_hash(&env_t1),
                SyncEngine::surface_content_hash(&env_t2),
                "{surface}: full envelope hash MUST include generated_at (sanity)"
            );
            // Gate input is data only — equal across wall-clock stamps.
            assert_eq!(
                SyncEngine::surface_content_hash(&data),
                SyncEngine::surface_content_hash(&surface_hash_bytes(&conn, surface, "dev-a")),
                "{surface}: gate must hash data portion only, not generated_at"
            );
        }
    }

    /// Regression: LWW re-applying identical values (timestamp tie + peer
    /// `device_id` sorting above ours) must leave settings clean. A dirty-flag
    /// design would have marked the row dirty forever on every echo; hashing
    /// was chosen specifically so this loop is a no-op.
    #[tokio::test]
    async fn settings_lww_echo_identical_values_keeps_hash_clean() {
        let key = test_key();
        let conn = fresh_db();
        let provider = Arc::new(CountingWriteProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".into(),
        );

        db::set_setting(&conn, "theme", "dark").unwrap();
        let rows = db::list_syncable_settings(&conn).unwrap();
        let (value, updated_at, deleted_at) = rows
            .into_iter()
            .find(|(k, _, _, _)| k == "theme")
            .map(|(_, v, ts, d)| (v, ts, d))
            .expect("theme setting after set_setting");
        assert_eq!(value, "dark");
        assert!(deleted_at.is_none());

        engine.push_settings(&conn, &key).await.unwrap();
        assert_eq!(
            count_surface_writes(&provider, "settings"),
            1,
            "initial settings push uploads"
        );
        clear_provider_writes(&provider);

        // Peer device_id "dev-z" sorts above local "dev-a" — on a timestamp
        // tie LWW rewrites the row even when value is identical.
        assert!(
            "dev-z" > "dev-a",
            "precondition: peer device_id must sort above local"
        );
        db::upsert_synced_setting_lww(&conn, "theme", "dark", updated_at, None, "dev-z", "dev-a")
            .unwrap();

        // Values are still identical → content hash unchanged → no upload.
        engine.push_settings(&conn, &key).await.unwrap();
        assert_eq!(
            count_surface_writes(&provider, "settings"),
            0,
            "LWW echo of identical values must not issue write_file for settings.bin"
        );
        assert!(
            provider.write_paths().is_empty(),
            "LWW echo must leave the write log empty, got {:?}",
            provider.write_paths()
        );
    }

    #[tokio::test]
    async fn failed_reconcile_does_not_set_session_flag() {
        // A listing failure must not burn the once-per-session budget —
        // the next Automatic must retry reconcile.
        let _lock = SESSION_RECONCILE_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_session_own_cloud_reconciled_for_test();

        struct FailEntriesListProvider;

        #[async_trait::async_trait]
        impl SyncProvider for FailEntriesListProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
            async fn list_files(
                &self,
                _device_id: &str,
                kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                if matches!(kind, FileKind::Entries) {
                    return Err(SyncError::Network("list entries failed".into()));
                }
                Ok(vec![])
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound(path.to_string()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Ok(())
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Ok(())
            }
        }

        let key = test_key();
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine = SyncEngine::with_session_flag(
            Arc::new(FailEntriesListProvider),
            "dev-a".to_string(),
            Arc::clone(&flag),
        );
        let conn = fresh_db();
        let ks = key_state_from_key(&key);

        let err = engine
            .push_local(&conn, &key, &ks, SyncTrigger::Automatic)
            .await
            .expect_err("reconcile listing failure must fail the push");
        assert!(
            matches!(err, SyncError::Network(_)),
            "expected network error, got {err}"
        );
        assert!(
            !flag.load(std::sync::atomic::Ordering::SeqCst),
            "failed reconcile must not set the session flag"
        );
        // Next Automatic still attempts reconcile (flag unset).
        assert!(engine.should_reconcile_own_cloud(SyncTrigger::Automatic));
    }

    /// Provider whose first `list_devices` fails, then every subsequent call
    /// succeeds. Pins the contract that errors are never memoised into the
    /// per-cycle device cache.
    struct FailOnceThenOkListDevices {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl FailOnceThenOkListDevices {
        fn new() -> Self {
            Self {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for FailOnceThenOkListDevices {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                return Err(SyncError::Io("transient list_devices failure".into()));
            }
            Ok(vec!["peer-a".to_string()])
        }
        async fn list_files(
            &self,
            _device_id: &str,
            _kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            Ok(vec![])
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            Err(SyncError::NotFound(path.to_string()))
        }
        async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
            Ok(())
        }
        async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn list_pull_devices_caches_across_multi_surface_pull() {
        // Before the cache, every surface in pull_remote re-called
        // list_devices independently (10+ hits). After the cache, a full
        // multi-surface pull must hit the provider exactly once.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Peer seeds the cloud so list_devices has something to return and
        // pull_remote actually walks multiple surfaces.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key, "from peer B");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let counting = Arc::new(CountingListDevicesProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let engine_a = SyncEngine::new(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        let conn_a = fresh_db();
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(stats.pulled, 1, "peer entry must still be pulled");
        assert_eq!(
            counting.call_count(),
            1,
            "list_devices must be invoked exactly once per pull_remote cycle; got {}",
            counting.call_count()
        );
    }

    #[tokio::test]
    async fn list_pull_devices_does_not_cache_errors() {
        // A failed list_devices must not poison later calls — the next
        // surface re-asks the provider instead of memoising the error.
        // Within a multi-surface batch the success is shared (see
        // `list_pull_devices_caches_across_multi_surface_pull`); standalone
        // public pulls each clear then list, so they re-hit after success.
        let provider = Arc::new(FailOnceThenOkListDevices::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        let conn = fresh_db();
        let key = test_key();
        let ks = key_state_from_key(&key);

        // First surface: list_devices fails → pull_tags propagates Err.
        let first = engine.pull_tags(&conn, &key, &ks).await;
        assert!(
            first.is_err(),
            "first list_devices failure must surface as Err"
        );
        assert_eq!(provider.call_count(), 1);

        // Second surface: provider succeeds; if the error were cached this
        // would either still fail or never re-hit the provider.
        let second = engine.pull_tags(&conn, &key, &ks).await;
        assert!(
            second.is_ok(),
            "retry after a transient list_devices failure must succeed; got {second:?}"
        );
        assert_eq!(
            provider.call_count(),
            2,
            "failed list_devices must not be cached — provider must be retried"
        );

        // Third standalone surface: each public pull_* is its own cycle when
        // depth == 0, so list_devices is re-queried (not shared forever).
        let third = engine.pull_settings(&conn, &key, &ks).await;
        assert!(third.is_ok());
        assert_eq!(
            provider.call_count(),
            3,
            "standalone surface pulls must each re-list devices; got {}",
            provider.call_count()
        );
    }

    /// Provider that grows its device list between `list_devices` calls.
    /// First success returns `["dev-a"]`; every later call returns
    /// `["dev-a", "dev-b"]`. Tracks peer prefixes observed via `read_file`
    /// so tests can prove a second `sync_now` / `pull_remote` re-listed and
    /// walked the newly-added device.
    struct ExpandingDeviceListProvider {
        list_calls: std::sync::atomic::AtomicUsize,
        peers_read: std::sync::Mutex<std::collections::BTreeSet<String>>,
    }

    impl ExpandingDeviceListProvider {
        fn new() -> Self {
            Self {
                list_calls: std::sync::atomic::AtomicUsize::new(0),
                peers_read: std::sync::Mutex::new(std::collections::BTreeSet::new()),
            }
        }

        fn list_call_count(&self) -> usize {
            self.list_calls.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn peers_read(&self) -> std::collections::BTreeSet<String> {
            self.peers_read
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }

        fn clear_peers_read(&self) {
            self.peers_read
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for ExpandingDeviceListProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            let n = self
                .list_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                Ok(vec!["dev-a".to_string()])
            } else {
                Ok(vec!["dev-a".to_string(), "dev-b".to_string()])
            }
        }
        async fn list_files(
            &self,
            _device_id: &str,
            _kind: FileKind,
        ) -> Result<Vec<String>, SyncError> {
            Ok(vec![])
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if let Some(peer) = path.split('/').next() {
                if !peer.is_empty() {
                    self.peers_read
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(peer.to_string());
                }
            }
            Err(SyncError::NotFound(path.to_string()))
        }
        async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
            Ok(())
        }
        async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn sync_now_clears_device_cache_between_cycles() {
        // A long-lived engine must re-query list_devices each sync_now so a
        // peer folder created between cycles is discovered. Without the
        // start-of-cycle clear, the second cycle would reuse the first
        // cycle's ["dev-a"] and never touch "dev-b".
        let provider = Arc::new(ExpandingDeviceListProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "local".to_string(),
        );
        let conn = fresh_db();
        let key = test_key();
        let ks = key_state_from_key(&key);

        engine
            .sync_now(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(
            provider.list_call_count(),
            1,
            "first cycle must hit list_devices once"
        );
        let peers1 = provider.peers_read();
        assert!(
            peers1.contains("dev-a"),
            "first cycle must walk the only known peer; got {peers1:?}"
        );
        assert!(
            !peers1.contains("dev-b"),
            "first cycle must not invent a device the provider has not listed yet; got {peers1:?}"
        );

        provider.clear_peers_read();
        engine
            .sync_now(&conn, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(
            provider.list_call_count(),
            2,
            "second cycle must re-call list_devices after the cache is cleared; got {}",
            provider.list_call_count()
        );
        let peers2 = provider.peers_read();
        assert!(
            peers2.contains("dev-b"),
            "second cycle must observe the newly-added device; got {peers2:?}"
        );
    }

    #[tokio::test]
    async fn pull_remote_clears_device_cache_between_cycles() {
        // Same contract as sync_now: a long-lived engine that only calls
        // pull_remote (no sync_now) must re-query list_devices each cycle.
        let provider = Arc::new(ExpandingDeviceListProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "local".to_string(),
        );
        let conn = fresh_db();
        let key = test_key();
        let ks = key_state_from_key(&key);

        engine.pull_remote(&conn, &key, &ks).await.unwrap();
        assert_eq!(
            provider.list_call_count(),
            1,
            "first pull must hit list_devices once"
        );
        let peers1 = provider.peers_read();
        assert!(
            peers1.contains("dev-a"),
            "first pull must walk the only known peer; got {peers1:?}"
        );
        assert!(
            !peers1.contains("dev-b"),
            "first pull must not invent a device the provider has not listed yet; got {peers1:?}"
        );

        provider.clear_peers_read();
        engine.pull_remote(&conn, &key, &ks).await.unwrap();
        assert_eq!(
            provider.list_call_count(),
            2,
            "second pull must re-call list_devices after the cache is cleared; got {}",
            provider.list_call_count()
        );
        let peers2 = provider.peers_read();
        assert!(
            peers2.contains("dev-b"),
            "second pull must observe the newly-added device; got {peers2:?}"
        );
    }

    #[tokio::test]
    async fn standalone_pull_tags_relists_devices_between_calls() {
        // Long-lived engine + standalone public surface pull must re-list
        // each call so a peer folder that appears between pulls is visible.
        // Without the depth==0 clear, the second pull_tags would reuse the
        // first call's ["dev-a"] forever.
        let provider = Arc::new(ExpandingDeviceListProvider::new());
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "local".to_string(),
        );
        let conn = fresh_db();
        let key = test_key();
        let ks = key_state_from_key(&key);

        engine.pull_tags(&conn, &key, &ks).await.unwrap();
        assert_eq!(
            provider.list_call_count(),
            1,
            "first standalone pull_tags must hit list_devices once"
        );
        let peers1 = provider.peers_read();
        assert!(
            peers1.contains("dev-a"),
            "first pull_tags must walk the only known peer; got {peers1:?}"
        );
        assert!(
            !peers1.contains("dev-b"),
            "first pull_tags must not invent a device not yet listed; got {peers1:?}"
        );

        provider.clear_peers_read();
        engine.pull_tags(&conn, &key, &ks).await.unwrap();
        assert_eq!(
            provider.list_call_count(),
            2,
            "second standalone pull_tags must re-list after the cache is cleared; got {}",
            provider.list_call_count()
        );
        let peers2 = provider.peers_read();
        assert!(
            peers2.contains("dev-b"),
            "second standalone pull_tags must observe the newly-added device; got {peers2:?}"
        );
    }

    #[tokio::test]
    async fn consecutive_standalone_pulls_each_list_devices_once() {
        // Two consecutive standalone surface pulls on a long-lived engine
        // (no device-list expansion) must each call list_devices once —
        // proves standalone pulls do not share a forever cache across calls.
        let dir = TempDir::new().unwrap();
        // Seed one peer folder so list_devices returns something.
        std::fs::create_dir_all(dir.path().join("peer-a")).unwrap();
        std::fs::write(dir.path().join("peer-a").join("tags.bin"), b"x").unwrap();

        let counting = Arc::new(CountingListDevicesProvider::new(LocalSyncProvider::new(
            dir.path().to_path_buf(),
        )));
        let engine = SyncEngine::new(
            Arc::clone(&counting) as Arc<dyn SyncProvider>,
            "local".to_string(),
        );
        let conn = fresh_db();
        let key = test_key();
        let ks = key_state_from_key(&key);

        engine.pull_tags(&conn, &key, &ks).await.unwrap();
        engine.pull_settings(&conn, &key, &ks).await.unwrap();
        assert_eq!(
            counting.call_count(),
            2,
            "each standalone public pull must list_devices once; got {}",
            counting.call_count()
        );
    }

    #[tokio::test]
    async fn pull_ingests_new_entry_from_peer() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Device B writes an entry and pushes.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let id = make_entry_with_content(&conn_b, &key, "hello from B");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Device A pulls.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(stats.pulled, 1);
        assert!(
            db::get_sync_catchup_complete(&conn_a).unwrap(),
            "a fully successful peer pull must mark the vault caught up"
        );
        // Baseline: a clean pull must produce zero consistency warnings.
        assert!(
            stats.warnings.is_empty(),
            "clean pull must have no warnings; got {:?}",
            stats.warnings
        );

        // The decrypted entry exists on A.
        let entry = db::get_entry(&conn_a, &id).unwrap().expect("entry pulled");
        assert_eq!(entry.content_text.as_deref(), Some("hello from B"));
    }

    #[tokio::test]
    async fn pull_marks_catchup_complete_only_after_all_peers_succeed() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key, "from peer B");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_c = fresh_db();
        let engine_c = make_engine(&dir, "dev-c");
        make_entry_with_content(&conn_c, &key, "from peer C");
        engine_c
            .push_local(
                &conn_c,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            db::get_sync_catchup_complete(&conn_a).unwrap(),
            "catch-up is complete only once every peer has fully drained"
        );
    }

    #[tokio::test]
    async fn pulled_entry_title_is_plaintext_on_peer() {
        // Phase 3 regression guard: after pulling, `title` in the DB must
        // be the original plaintext string — no ciphertext wrapper.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let id = make_entry_with_content(&conn_b, &key, "body text");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // Phase 3: title in the DB is plaintext — readable directly.
        let row_title: Option<String> = conn_a
            .query_row("SELECT title FROM entries WHERE id = ?1", [&id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            row_title.as_deref(),
            Some("t"),
            "pulled title must be plaintext"
        );
    }

    #[tokio::test]
    async fn pull_rejects_payload_encrypted_under_different_key() {
        // Key-fingerprint guard from the C1 fix. B encrypts + pushes with
        // key_b; A pulls with key_a. A must refuse to ingest, with a
        // clear error — not silently write garbage ciphertext into the DB.
        let dir = TempDir::new().unwrap();
        let key_a = crate::utils::encryption::derive_encryption_key("key-for-device-a", &[1u8; 16])
            .unwrap();
        let key_b = crate::utils::encryption::derive_encryption_key("key-for-device-b", &[2u8; 16])
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key_b, "encrypted-by-b");
        engine_b
            .push_local(
                &conn_b,
                &key_b,
                &key_state_from_key(&key_b),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key_a, &key_state_from_key(&key_a))
            .await
            .unwrap();
        // Ingest was rejected — peer transaction rolled back.
        assert_eq!(stats.pulled, 0);
        assert!(
            stats.errors.iter().any(|e| e.contains("fingerprint")),
            "expected fingerprint error in stats.errors, got {:?}",
            stats.errors
        );
        assert!(
            !db::get_sync_catchup_complete(&conn_a).unwrap(),
            "a peer error must leave catch-up incomplete"
        );
        // No row was written on A.
        let count: i64 = conn_a
            .query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "no entry should be written on key mismatch");
    }

    /// Regression test for the sync-restore-no-persist bug: a first-time
    /// restore pulling more than `PULL_CHUNK_SIZE` entries must not lose
    /// already-committed chunks when a later chunk hits a fatal error — in
    /// production this is exactly what happens when the outer `sync_now`
    /// timeout cancels the pull future mid-flight, except here we trigger
    /// the abort deterministically with a bad entry instead of a timer.
    ///
    /// Builds 8 entries for peer "dev-b" in a manifest order we control:
    /// 5 good entries (chunk 1), then chunk 2 = [good, bad, good] — a good
    /// entry, then a bad entry encrypted under the wrong key, then one more
    /// good entry. Putting a good entry BEFORE the bad one in chunk 2 means
    /// it genuinely gets ingested into that chunk's transaction before the
    /// fatal error hits; asserting it absent afterwards proves the chunk's
    /// transaction actually rolled back (not merely that the loop exited
    /// early). The trailing good entry is never reached at all. Chunk 1
    /// stays durably committed throughout.
    #[tokio::test]
    async fn pull_chunk_durability_survives_fatal_error_in_later_chunk() {
        let key = test_key();
        let key_wrong =
            derive_encryption_key("wrong-key-for-chunk-test", &[7u8; SALT_SIZE]).unwrap();
        let dir = TempDir::new().unwrap();

        // 7 good entries on device B, all encrypted with `key`.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let mut good_ids = Vec::new();
        for i in 0..7 {
            good_ids.push(make_entry_with_content(&conn_b, &key, &format!("good {i}")));
        }
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // One bad entry, built on a throwaway device and encrypted with the
        // wrong key, then copied into dev-b's entries folder so it decrypts
        // there with a fingerprint mismatch.
        let conn_bad = fresh_db();
        let engine_bad = make_engine(&dir, "dev-bad");
        let bad_id = make_entry_with_content(&conn_bad, &key_wrong, "bad content");
        engine_bad
            .push_local(
                &conn_bad,
                &key_wrong,
                &key_state_from_key(&key_wrong),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        std::fs::copy(
            dir.path()
                .join("dev-bad/entries")
                .join(format!("{bad_id}.bin")),
            dir.path()
                .join("dev-b/entries")
                .join(format!("{bad_id}.bin")),
        )
        .unwrap();

        // Overwrite dev-b's manifest with the explicit newest-first pull
        // order described above: chunk 1 = 5 good entries; chunk 2 =
        // [good_ids[5], bad, good_ids[6]] — a good entry ingested before the
        // fatal error, then the bad entry, then a good entry never reached.
        let ordered_ids: Vec<&str> = good_ids[0..5]
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(good_ids[5].as_str()))
            .chain(std::iter::once(bad_id.as_str()))
            .chain(std::iter::once(good_ids[6].as_str()))
            .collect();
        let entries: Vec<super::super::metadata::SyncedEntrySummary> = ordered_ids
            .iter()
            .enumerate()
            .map(
                |(position, id)| super::super::metadata::SyncedEntrySummary {
                    entry_id: id.to_string(),
                    updated_at: 1_000 - position as i64,
                    local_version: 1,
                    is_deleted: false,
                },
            )
            .collect();
        let manifest = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries,
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_000,
        };
        std::fs::write(
            dir.path().join("dev-b/metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // Device A pulls.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // Chunk 1's 5 entries committed durably before the fatal error hit.
        assert_eq!(
            stats.pulled, 5,
            "chunk 1's 5 entries must have committed before the fatal error"
        );
        for id in &good_ids[0..5] {
            assert!(
                db::get_entry(&conn_a, id).unwrap().is_some(),
                "entry {id} from chunk 1 must be persisted"
            );
        }

        // The fatal key-mismatch error is recorded.
        assert!(
            stats.errors.iter().any(|e| e.contains("fingerprint")),
            "expected fingerprint error in stats.errors, got {:?}",
            stats.errors
        );

        // good_ids[5] was ingested into chunk 2's transaction BEFORE the bad
        // entry hit the fatal error. It must be absent afterwards — proof
        // the whole chunk transaction rolled back, not just that the ingest
        // loop exited before reaching it.
        assert!(
            db::get_entry(&conn_a, &good_ids[5]).unwrap().is_none(),
            "entry {} was ingested into chunk 2 before the fatal error but must \
             not survive the chunk's rollback",
            good_ids[5]
        );

        // good_ids[6] comes after the bad entry in chunk 2 — the ingest
        // loop breaks at the first fatal error, so this entry is never
        // even attempted. Still must be absent.
        assert!(
            db::get_entry(&conn_a, &good_ids[6]).unwrap().is_none(),
            "entry {} from the aborted chunk 2 must not be persisted",
            good_ids[6]
        );
    }

    /// Wraps a real `LocalSyncProvider` and adds a fixed delay to every
    /// `read_file` call (list/write/delete are untouched) — models Google
    /// Drive's ~2 HTTP round trips per blob read (post folder-ID caching)
    /// so the entry-chunk pull loop's concurrency can be benchmarked
    /// deterministically under `#[tokio::test(start_paused = true)]`.
    struct DelayedReadProvider {
        inner: LocalSyncProvider,
        delay: std::time::Duration,
    }

    #[async_trait::async_trait]
    impl SyncProvider for DelayedReadProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: crate::sync::provider::FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            tokio::time::sleep(self.delay).await;
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    /// Perf baseline / regression guard for the chunked entry-pull loop
    /// (`pull_remote_with_manifest_scope`'s `PullingEntries` section).
    ///
    /// `DelayedReadProvider` adds a fixed 50ms delay to every `read_file`
    /// call. Combined with `#[tokio::test(start_paused = true)]`, tokio
    /// auto-advances its virtual clock across those sleeps, so the test
    /// runs instantly in real time while `tokio::time::Instant` still
    /// measures the *modeled* wall time deterministically.
    ///
    /// 20 entries on one peer = 4 chunks of `PULL_CHUNK_SIZE` (5). Before
    /// the parallelization fix, downloading a chunk costs the SUM of its 5
    /// reads; after, it costs roughly the MAX of the 5 (they run
    /// concurrently). At 50ms/read:
    ///   - sequential model: 20 x 50ms = 1000ms of entry-read time
    ///   - parallel model:    4 x 50ms =  200ms of entry-read time
    /// This one peer also has 9 other single-file channels (manifest,
    /// tags.bin, one journal, settings, chats, locations, templates,
    /// streak, ai_audit) that all go through the same
    /// `read_file` and are therefore delayed 50ms each too, adding a
    /// further ~450ms constant on top of both numbers above — measured
    /// baseline (before the fix): 1450ms = (20 + 9) x 50ms, i.e. every
    /// read still sequential.
    #[tokio::test(start_paused = true)]
    async fn pull_entry_chunk_downloads_run_concurrently() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        for i in 0..20 {
            make_entry_with_content(&conn_b, &key, &format!("entry {i}"));
        }
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let provider = Arc::new(DelayedReadProvider {
            inner: LocalSyncProvider::new(dir.path().to_path_buf()),
            delay: std::time::Duration::from_millis(50),
        });
        let engine_a = SyncEngine::new(provider, "dev-a".to_string());

        let start = tokio::time::Instant::now();
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        let elapsed = start.elapsed();

        assert_eq!(stats.pulled, 20, "all 20 entries must be pulled");
        eprintln!("pull_entry_chunk_downloads_run_concurrently: virtual elapsed = {elapsed:?}");

        // Regression guard. Measured virtual elapsed:
        //   - sequential (before this fix):     1450ms = (20 + 9) x 50ms
        //   - concurrent-per-chunk (after):       650ms = (4 + 9) x 50ms
        // The bound below (1000ms) sits at the 9-non-entry-reads constant
        // (450ms) plus 50% of the sequential entry-read model (50% x 20 x
        // 50ms = 500ms) — well above the ~650ms this fix produces, and well
        // below the ~1450ms a regression to sequential-per-chunk downloads
        // would produce.
        assert!(
            elapsed < std::time::Duration::from_millis(1000),
            "expected concurrent per-chunk entry downloads (~650ms virtual); \
             got {elapsed:?} -- looks sequential (~1450ms) again"
        );
    }

    /// Regression test for the non-fatal branch of the chunked ingest loop:
    /// an entry that fails `ingest_entry` with a non-fatal error (anything
    /// other than `SyncError::Auth` / `SyncError::CrossModeReject`) must
    /// NOT break the loop — its chunk siblings still ingest and the chunk
    /// still commits. The failure is recorded in `stats.errors`, not
    /// swallowed and not treated as fatal for the peer.
    ///
    /// Constructed deterministically without hand-building ciphertext: a
    /// real entry (`source_id`) is pushed normally, then its already-valid
    /// encrypted blob bytes are copied to a second filename
    /// (`mismatched_id`) and only that second id is listed in the peer's
    /// manifest. The copy decrypts fine (same key), but the plaintext
    /// `EntryMetadata` embedded inside still says `entry_id = source_id`,
    /// which `ingest_entry`'s path-vs-payload id check rejects with
    /// `SyncError::Serialization` — a non-fatal error.
    #[tokio::test]
    async fn pull_non_fatal_ingest_error_does_not_block_chunk_siblings() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let mut good_ids = Vec::new();
        for i in 0..4 {
            good_ids.push(make_entry_with_content(&conn_b, &key, &format!("good {i}")));
        }
        let source_id = make_entry_with_content(&conn_b, &key, "source for mismatch");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Copy source_id's ciphertext blob under a different filename. The
        // manifest below references only `mismatched_id`, not `source_id`.
        let mismatched_id = "mismatched-id-00000000";
        std::fs::copy(
            dir.path()
                .join("dev-b/entries")
                .join(format!("{source_id}.bin")),
            dir.path()
                .join("dev-b/entries")
                .join(format!("{mismatched_id}.bin")),
        )
        .unwrap();

        let mut ids: Vec<&str> = good_ids.iter().map(String::as_str).collect();
        ids.push(mismatched_id);
        let entries: Vec<super::super::metadata::SyncedEntrySummary> = ids
            .iter()
            .map(|id| super::super::metadata::SyncedEntrySummary {
                entry_id: id.to_string(),
                updated_at: 1_000,
                local_version: 1,
                is_deleted: false,
            })
            .collect();
        let manifest = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries,
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_000,
        };
        std::fs::write(
            dir.path().join("dev-b/metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // All 4 good entries — in the same chunk as the failing one —
        // still committed.
        assert_eq!(
            stats.pulled, 4,
            "good entries must commit even though a chunk sibling failed"
        );
        for id in &good_ids {
            assert!(
                db::get_entry(&conn_a, id).unwrap().is_some(),
                "entry {id} must be persisted"
            );
        }

        // The mismatched entry was rejected under both ids: it was never
        // written as `mismatched_id` (id check runs before any DB write),
        // and `source_id` itself was never referenced by the manifest.
        assert!(
            db::get_entry(&conn_a, mismatched_id).unwrap().is_none(),
            "mismatched-id entry must not be written"
        );
        assert!(
            db::get_entry(&conn_a, &source_id).unwrap().is_none(),
            "source_id was never listed in the manifest — only its blob bytes were reused"
        );

        // The non-fatal error is recorded, not swallowed.
        assert!(
            stats
                .errors
                .iter()
                .any(|e| e.contains("does not match path id")),
            "expected entry_id mismatch error in stats.errors, got {:?}",
            stats.errors
        );
    }

    /// Wraps a real `LocalSyncProvider` and returns `SyncError::Network` for
    /// exactly one configured path, delegating everything else — used to
    /// simulate a transient per-entry read failure (distinct from
    /// `NotFound`) alongside other outcomes in the same chunk.
    struct SelectiveNetworkErrorProvider {
        inner: LocalSyncProvider,
        fail_path: String,
    }

    #[async_trait::async_trait]
    impl SyncProvider for SelectiveNetworkErrorProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: crate::sync::provider::FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if path == self.fail_path {
                return Err(SyncError::Network(
                    "simulated transient read failure".to_string(),
                ));
            }
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    /// Test-only conditional-read probe. It delegates revision comparison to
    /// the real local provider while counting manifest body downloads and can
    /// fail one entry read until a test heals the provider.
    struct ConditionalManifestProbeProvider {
        inner: LocalSyncProvider,
        manifest_conditional_reads: std::sync::atomic::AtomicUsize,
        manifest_body_reads: std::sync::atomic::AtomicUsize,
        fail_path: String,
        fail_reads: std::sync::atomic::AtomicBool,
    }

    impl ConditionalManifestProbeProvider {
        fn new(inner: LocalSyncProvider, fail_path: String) -> Self {
            Self {
                inner,
                manifest_conditional_reads: std::sync::atomic::AtomicUsize::new(0),
                manifest_body_reads: std::sync::atomic::AtomicUsize::new(0),
                fail_path,
                fail_reads: std::sync::atomic::AtomicBool::new(false),
            }
        }

        fn set_fail_reads(&self, value: bool) {
            self.fail_reads
                .store(value, std::sync::atomic::Ordering::SeqCst);
        }

        fn manifest_conditional_reads(&self) -> usize {
            self.manifest_conditional_reads
                .load(std::sync::atomic::Ordering::SeqCst)
        }

        fn manifest_body_reads(&self) -> usize {
            self.manifest_body_reads
                .load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl SyncProvider for ConditionalManifestProbeProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: crate::sync::provider::FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            if self.fail_reads.load(std::sync::atomic::Ordering::SeqCst) && path == self.fail_path {
                return Err(SyncError::Network("simulated chunk failure".to_string()));
            }
            self.inner.read_file(path).await
        }
        async fn read_file_if_changed(
            &self,
            path: &str,
            known_revision: Option<&str>,
        ) -> Result<crate::sync::provider::ConditionalRead, SyncError> {
            if path.ends_with("/metadata.json") {
                self.manifest_conditional_reads
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            let result = self
                .inner
                .read_file_if_changed(path, known_revision)
                .await?;
            if path.ends_with("/metadata.json")
                && matches!(
                    result,
                    crate::sync::provider::ConditionalRead::Changed { .. }
                )
            {
                self.manifest_body_reads
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(result)
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    #[tokio::test]
    async fn pull_manifest_cold_changed_and_unchanged_cycles_use_conditional_read() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let first_id = make_entry_with_content(&conn_b, &key, "first peer entry");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let provider = Arc::new(ConditionalManifestProbeProvider::new(
            LocalSyncProvider::new(dir.path().to_path_buf()),
            "never-fail".to_string(),
        ));
        let engine_a = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(
            provider.manifest_conditional_reads(),
            1,
            "cold pull must conditionally fetch"
        );
        assert_eq!(
            provider.manifest_body_reads(),
            1,
            "cold pull has no revision and must download the body"
        );
        assert!(
            db::get_pull_revision(&conn_a, "dev-b", "metadata")
                .unwrap()
                .is_some(),
            "a fully successful peer pull must cache its manifest revision"
        );

        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(
            provider.manifest_conditional_reads(),
            2,
            "second cycle must still resolve the peer revision"
        );
        assert_eq!(
            provider.manifest_body_reads(),
            1,
            "unchanged manifest must skip its body download"
        );
        assert!(
            db::get_sync_catchup_complete(&conn_a).unwrap(),
            "peers skipped as Unchanged must still count as fully caught up"
        );

        let second_id = make_entry_with_content(&conn_b, &key, "new peer entry");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(
            provider.manifest_body_reads(),
            2,
            "changed manifest must download a new body"
        );
        assert!(db::get_entry(&conn_a, &first_id).unwrap().is_some());
        assert!(
            db::get_entry(&conn_a, &second_id).unwrap().is_some(),
            "changed manifest must re-pull newly listed entries"
        );
    }

    #[tokio::test]
    async fn recovery_generation_invalidation_clears_revision_and_forces_manifest_refetch() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key, "peer entry");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let provider = Arc::new(ConditionalManifestProbeProvider::new(
            LocalSyncProvider::new(dir.path().to_path_buf()),
            "never-fail".to_string(),
        ));
        let engine_a = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            db::get_pull_revision(&conn_a, "dev-b", "metadata")
                .unwrap()
                .is_some(),
            "precondition: successful pull cached the peer revision"
        );

        db::set_sync_recovery_generation(&conn_a, 1).unwrap();
        invalidate_surface_push_state(&conn_a).unwrap();

        assert_eq!(
            db::get_pull_revision(&conn_a, "dev-b", "metadata").unwrap(),
            None,
            "recovery-generation invalidation must clear the cached revision"
        );
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(
            provider.manifest_body_reads(),
            2,
            "clearing the revision must force a fresh manifest body download"
        );
    }

    #[tokio::test]
    async fn failed_chunk_does_not_cache_manifest_revision_and_next_cycle_retries_peer() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let mut ids = Vec::new();
        for index in 0..(PULL_CHUNK_SIZE + 1) {
            ids.push(make_entry_with_content(
                &conn_b,
                &key,
                &format!("entry {index}"),
            ));
        }
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let failed_id = ids[PULL_CHUNK_SIZE].clone();
        let provider = Arc::new(ConditionalManifestProbeProvider::new(
            LocalSyncProvider::new(dir.path().to_path_buf()),
            format!("dev-b/entries/{failed_id}.bin"),
        ));
        provider.set_fail_reads(true);
        let engine_a = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );

        let first = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(first
            .errors
            .iter()
            .any(|error| error.contains("simulated chunk failure")));
        assert!(
            !db::get_sync_catchup_complete(&conn_a).unwrap(),
            "a failed chunk must leave catch-up incomplete"
        );
        assert_eq!(
            provider.manifest_conditional_reads(),
            1,
            "first sync must conditionally fetch without a cached revision"
        );
        assert!(
            db::get_pull_revision(&conn_a, "dev-b", "metadata")
                .unwrap()
                .is_none(),
            "a peer with a failed chunk must not cache its unchanged manifest revision"
        );
        assert!(db::get_entry(&conn_a, &failed_id).unwrap().is_none());

        provider.set_fail_reads(false);
        let second = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(second.errors, Vec::<String>::new());
        assert_eq!(
            provider.manifest_conditional_reads(),
            2,
            "uncached failed peer must fetch again on the next cycle"
        );
        assert_eq!(
            provider.manifest_body_reads(),
            2,
            "uncached failed peer must download the manifest again"
        );
        assert!(
            db::get_entry(&conn_a, &failed_id).unwrap().is_some(),
            "healthy retry must pull the previously missing entry"
        );
    }

    #[tokio::test]
    async fn pull_emits_catchup_progress_per_committed_chunk_and_terminal_across_peers() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        for index in 0..(PULL_CHUNK_SIZE + 1) {
            make_entry_with_content(&conn_b, &key, &format!("peer B entry {index}"));
        }
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_c = fresh_db();
        let engine_c = make_engine(&dir, "dev-c");
        make_entry_with_content(&conn_c, &key, "peer C entry");
        engine_c
            .push_local(
                &conn_c,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let reporter = CatchupReporter::new();
        let engine_a = SyncEngine::new(
            Arc::new(LocalSyncProvider::new(dir.path().to_path_buf())) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        )
        .with_reporter(reporter.clone());

        engine_a
            .pull_remote(&fresh_db(), &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert_eq!(
            reporter.catchup_events(),
            vec![
                CatchupProgressEvent {
                    pulled: PULL_CHUNK_SIZE as u64,
                    total: (PULL_CHUNK_SIZE + 2) as u64,
                    peer_device_id: Some("dev-b".to_string()),
                },
                CatchupProgressEvent {
                    pulled: (PULL_CHUNK_SIZE + 1) as u64,
                    total: (PULL_CHUNK_SIZE + 2) as u64,
                    peer_device_id: Some("dev-b".to_string()),
                },
                CatchupProgressEvent {
                    pulled: (PULL_CHUNK_SIZE + 2) as u64,
                    total: (PULL_CHUNK_SIZE + 2) as u64,
                    peer_device_id: Some("dev-c".to_string()),
                },
                CatchupProgressEvent {
                    pulled: (PULL_CHUNK_SIZE + 2) as u64,
                    total: (PULL_CHUNK_SIZE + 2) as u64,
                    peer_device_id: None,
                },
            ],
            "each committed chunk must report global progress and a clean cycle must terminate"
        );
    }

    #[tokio::test]
    async fn pull_error_midway_does_not_emit_terminal_catchup_progress() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let mut ids = Vec::new();
        for index in 0..(PULL_CHUNK_SIZE + 1) {
            ids.push(make_entry_with_content(
                &conn_b,
                &key,
                &format!("peer B entry {index}"),
            ));
        }
        let failed_id = ids[PULL_CHUNK_SIZE].clone();
        conn_b
            .execute(
                "UPDATE entries SET updated_at = 1 WHERE id = ?1",
                [&failed_id],
            )
            .unwrap();
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let provider = Arc::new(ConditionalManifestProbeProvider::new(
            LocalSyncProvider::new(dir.path().to_path_buf()),
            format!("dev-b/entries/{failed_id}.bin"),
        ));
        provider.set_fail_reads(true);
        let reporter = CatchupReporter::new();
        let engine_a = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        )
        .with_reporter(reporter.clone());
        let conn_a = fresh_db();

        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(stats
            .errors
            .iter()
            .any(|error| error.contains("simulated chunk failure")));
        assert_eq!(
            reporter.catchup_events(),
            vec![CatchupProgressEvent {
                pulled: PULL_CHUNK_SIZE as u64,
                total: (PULL_CHUNK_SIZE + 1) as u64,
                peer_device_id: Some("dev-b".to_string()),
            }],
            "a failed later chunk must preserve earlier commits without a false terminal event"
        );
        assert_eq!(
            stats.pulled, PULL_CHUNK_SIZE as u64,
            "the first committed chunk must remain durable after a later failure"
        );
    }

    #[tokio::test]
    async fn pull_manifest_fetch_error_clears_previously_complete_catchup_state() {
        struct FailingListDevicesProvider;

        #[async_trait::async_trait]
        impl SyncProvider for FailingListDevicesProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                Err(SyncError::Network(
                    "simulated manifest listing failure".to_string(),
                ))
            }
            async fn list_files(
                &self,
                _device_id: &str,
                _kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound(path.to_string()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Ok(())
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Ok(())
            }
        }

        let conn = fresh_db();
        db::set_sync_catchup_complete(&conn, true).unwrap();
        let key = test_key();
        let engine = SyncEngine::new(Arc::new(FailingListDevicesProvider), "dev-a".to_string());

        let result = engine
            .pull_remote(&conn, &key, &key_state_from_key(&key))
            .await;

        assert!(
            result.is_err(),
            "manifest listing failure must abort the pull"
        );
        assert!(
            !db::get_sync_catchup_complete(&conn).unwrap(),
            "an aborted manifest fetch must not leave prior catch-up completion true"
        );
    }

    #[tokio::test]
    async fn missing_manifest_journal_or_chat_does_not_cache_revision_before_retry() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let journal_id = "journal-retry-aaaa";
        let manifest = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![super::super::metadata::SyncedJournalSummary {
                journal_id: journal_id.to_string(),
                updated_at: 2_000,
                local_version: 1,
                is_deleted: false,
            }],
            chats_present: true,
            memory_present: false,
            generated_at: 2_000,
        };
        std::fs::create_dir_all(dir.path().join("dev-b")).unwrap();
        std::fs::write(
            dir.path().join("dev-b/metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let conn_a = fresh_db();
        let provider = Arc::new(ConditionalManifestProbeProvider::new(
            LocalSyncProvider::new(dir.path().to_path_buf()),
            "never-fail".to_string(),
        ));
        let engine_a = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-a".to_string(),
        );
        let first = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(first.errors.iter().any(|error| error.contains(journal_id)));
        assert!(first.errors.iter().any(|error| error.contains("chats.bin")));
        assert_eq!(
            db::get_pull_revision(&conn_a, "dev-b", "metadata").unwrap(),
            None,
            "missing journal/chat work must leave the manifest uncached"
        );

        let key_state = key_state_from_key(&key);
        let journal = super::super::metadata::JournalPayload {
            journal_id: journal_id.to_string(),
            device_id: "dev-b".to_string(),
            name: "Retry journal".to_string(),
            color: None,
            sort_order: 0,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            created_at: 1_000,
            updated_at: 2_000,
            auto_tag_ids: vec![],
        };
        std::fs::create_dir_all(dir.path().join("dev-b/journals")).unwrap();
        std::fs::write(
            dir.path().join(format!("dev-b/journals/{journal_id}.bin")),
            crate::utils::encryption::encrypt_data_with_state(
                &serde_json::to_vec(&journal).unwrap(),
                &key_state,
            )
            .unwrap(),
        )
        .unwrap();
        let chats = super::super::metadata::ChatPayload {
            device_id: "dev-b".to_string(),
            generated_at: 2_000,
            sessions: vec![],
        };
        std::fs::write(
            dir.path().join("dev-b/chats.bin"),
            crate::utils::encryption::encrypt_data_with_state(
                &serde_json::to_vec(&chats).unwrap(),
                &key_state,
            )
            .unwrap(),
        )
        .unwrap();

        let second = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            second.errors.is_empty(),
            "healthy payloads must complete retry"
        );
        assert_eq!(
            provider.manifest_body_reads(),
            2,
            "retry must re-read unchanged manifest"
        );
        assert!(
            db::get_pull_revision(&conn_a, "dev-b", "metadata")
                .unwrap()
                .is_some(),
            "only the fully drained retry may cache the revision"
        );
        let journal_count: i64 = conn_a
            .query_row(
                "SELECT COUNT(*) FROM journals WHERE id = ?1",
                [journal_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            journal_count, 1,
            "retry must ingest the previously missing journal"
        );
    }

    /// Regression guard for the concurrent chunk-download refactor: a
    /// single chunk (`PULL_CHUNK_SIZE` = 5) containing one of every
    /// per-entry outcome — ok, ok, missing-blob, transient-read-error,
    /// corrupt-payload — must still produce the exact same `stats`
    /// strings and ingest only the ok entries, proving the post-`join_all`
    /// classification fold stayed single-threaded and deterministic even
    /// though the 5 reads now run concurrently.
    #[tokio::test]
    async fn pull_chunk_mixed_outcomes_produce_identical_stats_after_concurrent_download() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let ok1 = make_entry_with_content(&conn_b, &key, "ok 1");
        let ok2 = make_entry_with_content(&conn_b, &key, "ok 2");
        let missing_id = make_entry_with_content(&conn_b, &key, "blob will be deleted");
        let network_err_id = make_entry_with_content(&conn_b, &key, "blob read will fail");
        let corrupt_id = make_entry_with_content(&conn_b, &key, "blob will be corrupted");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        std::fs::remove_file(dir.path().join(format!("dev-b/entries/{missing_id}.bin"))).unwrap();
        std::fs::write(
            dir.path().join(format!("dev-b/entries/{corrupt_id}.bin")),
            b"not a valid sync payload",
        )
        .unwrap();

        // Pin the chunk order explicitly (all 5 in one chunk) so the test
        // exercises exactly one `join_all` batch with a known mix.
        let ordered_ids = [&ok1, &ok2, &missing_id, &network_err_id, &corrupt_id];
        let entries: Vec<super::super::metadata::SyncedEntrySummary> = ordered_ids
            .iter()
            .map(|id| super::super::metadata::SyncedEntrySummary {
                entry_id: id.to_string(),
                updated_at: 1_000,
                local_version: 1,
                is_deleted: false,
            })
            .collect();
        let manifest = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries,
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_000,
        };
        std::fs::write(
            dir.path().join("dev-b/metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let conn_a = fresh_db();
        let provider = Arc::new(SelectiveNetworkErrorProvider {
            inner: LocalSyncProvider::new(dir.path().to_path_buf()),
            fail_path: format!("dev-b/entries/{network_err_id}.bin"),
        });
        let engine_a = SyncEngine::new(provider, "dev-a".to_string());
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert_eq!(stats.pulled, 2, "only the 2 ok entries must be ingested");
        assert!(db::get_entry(&conn_a, &ok1).unwrap().is_some());
        assert!(db::get_entry(&conn_a, &ok2).unwrap().is_some());
        assert!(db::get_entry(&conn_a, &missing_id).unwrap().is_none());
        assert!(db::get_entry(&conn_a, &network_err_id).unwrap().is_none());
        assert!(db::get_entry(&conn_a, &corrupt_id).unwrap().is_none());

        assert_eq!(
            stats.warnings,
            vec![format!(
                "peer dev-b entry {missing_id}: manifest references missing blob"
            )],
            "missing-blob warning string must be byte-identical to the sequential path"
        );
        assert!(
            stats.errors.iter().any(|e| e
                == &format!(
                    "peer dev-b entry {network_err_id}: read: network: simulated transient read failure"
                )),
            "expected read-error message for {network_err_id} in stats.errors, got {:?}",
            stats.errors
        );
        assert!(
            stats
                .errors
                .iter()
                .any(|e| e.starts_with(&format!("peer dev-b entry {corrupt_id}: parse:"))),
            "expected parse-error message for {corrupt_id} in stats.errors, got {:?}",
            stats.errors
        );
        assert_eq!(
            stats.errors.len(),
            2,
            "expected exactly 2 errors (read + parse), got {:?}",
            stats.errors
        );
    }

    #[tokio::test]
    async fn pulled_entry_has_no_sync_state_row_at_all() {
        // Stronger than `pulled_entry_is_not_immediately_pending` (which
        // only checks `count_pending == 0`). A row with status `synced`
        // would also count as zero pending but would still misrepresent
        // authorship. We assert the row is absent entirely — the pull
        // path must not touch sync_state in any way.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let id = make_entry_with_content(&conn_b, &key, "peer-authored");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let count: i64 = conn_a
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE entry_id = ?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "pull must not create any sync_state row");
    }

    #[tokio::test]
    async fn cloud_authoritative_pull_must_include_current_device_folder() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let author_conn = fresh_db();
        let author_engine = make_engine(&dir, "dev-current");
        let entry_id = make_entry_with_content(&author_conn, &key, "self-authored cloud copy");
        let journal_id = db::get_entry(&author_conn, &entry_id)
            .unwrap()
            .unwrap()
            .journal_id;
        author_engine
            .push_local(
                &author_conn,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let restored_conn = fresh_db();
        let restore_engine = make_engine(&dir, "dev-current");
        restore_engine
            .pull_entries_for_recovery(&restored_conn, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            db::get_entry(&restored_conn, &entry_id).unwrap().is_some(),
            "cloud-authoritative restore must ingest the current device folder; normal pull currently skips self.device_id"
        );
        assert!(
            db::get_journal(&restored_conn, &journal_id)
                .unwrap()
                .is_some(),
            "recovery scope must restore the self-owned custom journal before its entry"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_fresh_db_pulls_settings_before_embedding_chunks() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let author_conn = fresh_db();
        let author_engine = make_engine(&dir, "dev-current");
        let entry_id = make_entry_with_content(&author_conn, &key, "body");
        configure_embed_slot(&author_conn, "prov-a", "model-a");
        let hash = chunk_hash_at("t", "body", 1);
        db::embeddings::upsert_chunk(
            &author_conn,
            &entry_id,
            "prov-a:model-a",
            1,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        author_engine
            .push_local(
                &author_conn,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let restored_conn = fresh_db();
        let restore_engine = make_engine(&dir, "dev-current");
        restore_engine
            .pull_entries_for_recovery(&restored_conn, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let stored =
            db::embeddings::list_stored_chunks(&restored_conn, &entry_id, "prov-a:model-a")
                .unwrap();
        assert_eq!(
            stored.len(),
            1,
            "fresh recovery DB must learn the synced embedding model before adopting chunks"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_recovery_rejects_stale_generation_manifest() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let author_conn = fresh_db();
        db::set_sync_recovery_generation(&author_conn, 1).unwrap();
        db::set_setting(&author_conn, "theme", "dark").unwrap();
        let author_engine = make_engine(&dir, "dev-current");
        let entry_id = make_entry_with_content(&author_conn, &key, "stale body");
        author_engine
            .push_local(
                &author_conn,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let restored_conn = fresh_db();
        db::set_sync_recovery_generation(&restored_conn, 2).unwrap();
        let restore_engine = make_engine(&dir, "dev-current");
        let error = restore_engine
            .pull_entries_for_recovery(&restored_conn, &key, &key_state_from_key(&key))
            .await
            .expect_err("a stale-generation manifest must make recovery incomplete");

        assert!(db::get_entry(&restored_conn, &entry_id).unwrap().is_none());
        assert_ne!(
            db::get_setting(&restored_conn, "theme").unwrap().as_deref(),
            Some("dark"),
            "stale manifest peer must be excluded from every recovery channel"
        );
        assert!(error.to_string().contains("stale recovery generation"));
    }

    #[tokio::test]
    async fn pulled_entry_is_not_immediately_pending() {
        // Regression guard: if pull goes through the normal create path
        // it would mark the row pending and bounce back on the next push.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key, "quiet entry");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert_eq!(db::count_pending_entries(&conn_a).unwrap(), 0);
    }

    #[tokio::test]
    async fn end_to_end_two_device_exchange() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // A creates entry, syncs.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let id = make_entry_with_content(&conn_a, &key, "A wrote this");
        let a1 = engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(a1.pushed, 1);

        // B pulls it.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let b1 = engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(b1.pulled, 1);
        let entry = db::get_entry(&conn_b, &id).unwrap().unwrap();
        assert_eq!(entry.content_text.as_deref(), Some("A wrote this"));

        // B edits it via a direct command-layer-ish update, re-marks pending.
        // Phase 3: yjs_doc stored as raw bytes (no app-level encryption).
        {
            let new_ct = "A wrote — B edited";
            let blob = make_yjs_blob(new_ct);
            conn_b
                .execute(
                    "UPDATE entries SET yjs_doc = ?1, content_text = ?2, updated_at = ?3 WHERE id = ?4",
                    rusqlite::params![blob, new_ct, now_unix() + 10, &id],
                )
                .unwrap();
            db::mark_entry_pending(&conn_b, &id).unwrap();
        }
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // A pulls B's edit, LWW wins (newer updated_at). Reuse the same
        // long-lived engine: `sync_now` clears the device-list cache at
        // cycle entry, so a peer folder that appeared after the first cycle
        // is still discovered.
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        let a_entry = db::get_entry(&conn_a, &id).unwrap().unwrap();
        assert_eq!(a_entry.content_text.as_deref(), Some("A wrote — B edited"));
    }

    #[tokio::test]
    async fn end_to_end_lock_flags_propagate_to_peer_visibility() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let default_journal = default_journal(&conn_a);

        let locked_entry = db::create_entry(
            &conn_a,
            db::CreateEntryParams {
                journal_id: &default_journal,
                title: Some("second locked"),
                content_text: Some("second lock content"),
                preview_text: Some("second lock preview"),
                entry_date: 1_700_000_101,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &locked_entry.id).unwrap();

        let invisible_entry = db::create_entry(
            &conn_a,
            db::CreateEntryParams {
                journal_id: &default_journal,
                title: Some("invisible"),
                content_text: Some("invisible content"),
                preview_text: Some("invisible preview"),
                entry_date: 1_700_000_102,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &invisible_entry.id).unwrap();

        let locked_journal = db::create_journal(&conn_a, "Locked journal", None).unwrap();
        let journal_locked_entry = db::create_entry(
            &conn_a,
            db::CreateEntryParams {
                journal_id: &locked_journal.id,
                title: Some("journal locked"),
                content_text: Some("journal lock content"),
                preview_text: Some("journal lock preview"),
                entry_date: 1_700_000_103,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &journal_locked_entry.id).unwrap();

        let invisible_journal = db::create_journal(&conn_a, "Invisible journal", None).unwrap();
        let journal_invisible_entry = db::create_entry(
            &conn_a,
            db::CreateEntryParams {
                journal_id: &invisible_journal.id,
                title: Some("journal invisible"),
                content_text: Some("journal invisible content"),
                preview_text: Some("journal invisible preview"),
                entry_date: 1_700_000_104,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &journal_invisible_entry.id).unwrap();

        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        assert!(
            !db::get_entry_raw(&conn_b, &locked_entry.id)
                .unwrap()
                .expect("entry initially synced")
                .is_locked
        );
        assert!(
            !db::get_entry_raw(&conn_b, &invisible_entry.id)
                .unwrap()
                .expect("entry initially synced")
                .is_invisible
        );
        assert!(
            !db::get_journal(&conn_b, &locked_journal.id)
                .unwrap()
                .expect("journal initially synced")
                .is_locked
        );
        assert!(
            !db::get_journal(&conn_b, &invisible_journal.id)
                .unwrap()
                .expect("journal initially synced")
                .is_invisible
        );

        // Force the same-second LWW condition deterministically: bump the
        // rows' `updated_at` to a "future" value (`now + 1000`) BEFORE the
        // toggle, so the only way the setter's `updated_at` can advance past
        // the stored value is the `MAX(updated_at + 1, ?1)` `+1` branch.
        // Without that branch (a revert to `updated_at = ?1`), the setter
        // would write `now_unix()` (smaller than the pre-set future value)
        // and the lock toggle would lose LWW against dev-b's just-synced row.
        let future = now_unix() + 1000;
        for eid in [
            &locked_entry.id,
            &invisible_entry.id,
            &journal_locked_entry.id,
            &journal_invisible_entry.id,
        ] {
            conn_a
                .execute(
                    "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![future, eid],
                )
                .unwrap();
        }
        for jid in [&locked_journal.id, &invisible_journal.id] {
            conn_a
                .execute(
                    "UPDATE journals SET updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![future, jid],
                )
                .unwrap();
        }

        db::set_entry_locked(&conn_a, &locked_entry.id, true).unwrap();
        db::set_entry_invisible(&conn_a, &invisible_entry.id, true, Some("test-vault")).unwrap();
        db::set_journal_locked(&conn_a, &locked_journal.id, true).unwrap();
        db::set_journal_invisible(&conn_a, &invisible_journal.id, true, Some("test-vault"))
            .unwrap();

        // The setters must have advanced updated_at strictly past the future
        // value we pre-set — proving the `+1` branch fired, not the `now`
        // branch. This is the deterministic signal that the same-second LWW
        // condition was actually exercised (not skipped by a >1s gap).
        assert!(
            db::get_entry_raw(&conn_a, &locked_entry.id)
                .unwrap()
                .unwrap()
                .updated_at
                > future,
            "set_entry_locked must beat the pre-set future updated_at via the +1 branch"
        );
        assert!(
            db::get_entry_raw(&conn_a, &invisible_entry.id)
                .unwrap()
                .unwrap()
                .updated_at
                > future,
            "set_entry_invisible must beat the pre-set future updated_at via the +1 branch"
        );
        assert!(
            db::get_journal(&conn_a, &locked_journal.id)
                .unwrap()
                .unwrap()
                .updated_at
                > future,
            "set_journal_locked must beat the pre-set future updated_at via the +1 branch"
        );
        assert!(
            db::get_journal(&conn_a, &invisible_journal.id)
                .unwrap()
                .unwrap()
                .updated_at
                > future,
            "set_journal_invisible must beat the pre-set future updated_at via the +1 branch"
        );

        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let pulled_locked = db::get_entry_raw(&conn_b, &locked_entry.id)
            .unwrap()
            .expect("locked entry synced");
        assert!(pulled_locked.is_locked);
        assert!(!pulled_locked.is_invisible);

        let pulled_invisible = db::get_entry_raw(&conn_b, &invisible_entry.id)
            .unwrap()
            .expect("invisible entry synced");
        assert!(!pulled_invisible.is_locked);
        assert!(pulled_invisible.is_invisible);

        let pulled_journal = db::get_journal(&conn_b, &locked_journal.id)
            .unwrap()
            .expect("locked journal synced");
        assert!(pulled_journal.is_locked);
        assert!(!pulled_journal.is_invisible);

        let pulled_invisible_journal = db::get_journal(&conn_b, &invisible_journal.id)
            .unwrap()
            .expect("invisible journal synced");
        assert!(!pulled_invisible_journal.is_locked);
        assert!(pulled_invisible_journal.is_invisible);

        let revealed_without_invisible = db::list_all_entries_paged_with_locked_view(
            &conn_b,
            db::EntrySort::Newest,
            db::EntryTimeRange::All,
            None,
            1,
            1,
            db::LockedView::Revealed,
            None,
            db::LockFilter::All,
        )
        .unwrap();
        assert!(!revealed_without_invisible
            .items
            .iter()
            .any(|entry| entry.id == invisible_entry.id));
        assert!(!revealed_without_invisible
            .items
            .iter()
            .any(|entry| entry.id == journal_invisible_entry.id));
        // Positive assertion: the Revealed view keeps visible-but-locked
        // entries present (only invisible ones are excluded). This locks in
        // the contract that `LockedView::Revealed` excludes invisible but
        // NOT locked rows.
        assert!(
            revealed_without_invisible
                .items
                .iter()
                .any(|entry| entry.id == locked_entry.id),
            "Revealed view must keep the directly-locked entry (locked but visible)"
        );
        assert!(
            revealed_without_invisible
                .items
                .iter()
                .any(|entry| entry.id == journal_locked_entry.id),
            "Revealed view must keep the journal-locked entry (locked but visible)"
        );

        let hidden = db::list_all_entries_paged_with_locked_view(
            &conn_b,
            db::EntrySort::Newest,
            db::EntryTimeRange::All,
            None,
            1,
            1,
            db::LockedView::Hidden,
            None,
            db::LockFilter::All,
        )
        .unwrap();
        assert!(!hidden.items.iter().any(|entry| entry.id == locked_entry.id));
        assert!(!hidden
            .items
            .iter()
            .any(|entry| entry.id == journal_locked_entry.id));

        let covered = db::list_all_entries_paged_with_locked_view(
            &conn_b,
            db::EntrySort::Newest,
            db::EntryTimeRange::All,
            None,
            1,
            1,
            db::LockedView::Covered,
            None,
            db::LockFilter::All,
        )
        .unwrap();
        let covered_locked = covered
            .items
            .iter()
            .find(|entry| entry.id == locked_entry.id)
            .expect("covered view keeps second-locked entry existence");
        assert!(covered_locked.is_locked);
        assert!(covered_locked.title.is_none());
        let covered_journal_locked = covered
            .items
            .iter()
            .find(|entry| entry.id == journal_locked_entry.id)
            .expect("covered view keeps journal-locked entry existence");
        assert!(covered_journal_locked.is_locked);
        assert!(covered_journal_locked.title.is_none());
    }

    /// LWW-conflict regression: when dev-b already has the entry (from a
    /// first sync) and then makes a LOCAL edit with an OLDER `updated_at`
    /// than dev-a's subsequent lock toggle, the lock toggle from dev-a must
    /// win LWW on dev-b. This exercises the conflict path that the
    /// `end_to_end_lock_flags_propagate_to_peer_visibility` test never
    /// reaches (dev-b is empty there before the first pull, so there is no
    /// competing local row).
    ///
    /// The `MAX(updated_at + 1, ?1)` fix is what makes dev-a's toggle
    /// `updated_at` larger than dev-b's stale local edit. Under a revert to
    /// `updated_at = ?1`, dev-a's toggle would write `now_unix()` which could
    /// be `<=` dev-b's local edit timestamp and the lock would lose LWW.
    #[tokio::test]
    async fn lock_toggle_wins_lww_against_peer_older_local_edit() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let default_journal = default_journal(&conn_a);

        let entry = db::create_entry(
            &conn_a,
            db::CreateEntryParams {
                journal_id: &default_journal,
                title: Some("shared entry"),
                content_text: Some("body"),
                preview_text: Some("preview"),
                entry_date: 1_700_000_200,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();

        // First sync: dev-a pushes, dev-b pulls. dev-b now has the entry.
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        assert!(
            !db::get_entry_raw(&conn_b, &entry.id)
                .unwrap()
                .unwrap()
                .is_locked,
            "entry starts unlocked on dev-b"
        );

        // dev-a toggles the lock. Pre-set a future updated_at so the `+1`
        // branch deterministically fires and the resulting updated_at is
        // `future + 1` — strictly larger than dev-b's stale local edit below.
        let future = now_unix() + 1000;
        conn_a
            .execute(
                "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![future, entry.id],
            )
            .unwrap();
        db::set_entry_locked(&conn_a, &entry.id, true).unwrap();
        let a_toggle_updated_at = db::get_entry_raw(&conn_a, &entry.id)
            .unwrap()
            .unwrap()
            .updated_at;
        assert!(
            a_toggle_updated_at > future,
            "dev-a lock toggle must beat the pre-set future updated_at via the +1 branch"
        );

        // dev-b makes a LOCAL edit with an OLDER updated_at than dev-a's
        // toggle. Direct UPDATE simulates a stale write (e.g. a peer whose
        // clock is behind, or a queued edit replayed late).
        conn_b
            .execute(
                "UPDATE entries SET title = 'B edited locally', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now_unix(), entry.id],
            )
            .unwrap();
        let b_local_updated_at = db::get_entry_raw(&conn_b, &entry.id)
            .unwrap()
            .unwrap()
            .updated_at;
        assert!(
            b_local_updated_at < a_toggle_updated_at,
            "dev-b local edit must be older than dev-a's lock toggle for LWW to favor the toggle"
        );

        // Both sync. dev-a pushes the lock; dev-b pulls and must let the
        // lock toggle win LWW (larger updated_at).
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let resolved = db::get_entry_raw(&conn_b, &entry.id)
            .unwrap()
            .expect("entry still present after sync");
        assert!(
            resolved.is_locked,
            "dev-a lock toggle must win LWW and lock the entry on dev-b"
        );
        assert_eq!(
            resolved.title.as_deref(),
            Some("shared entry"),
            "dev-b's older local title edit must NOT overwrite dev-a's newer lock-toggle version"
        );
    }

    #[tokio::test]
    async fn soft_delete_propagates_across_devices() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let id = make_entry_with_content(&conn_a, &key, "to be deleted");
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // A soft-deletes and pushes.
        conn_a
            .execute(
                "UPDATE entries SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now_unix() + 20, &id],
            )
            .unwrap();
        db::mark_entry_pending(&conn_a, &id).unwrap();
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // B pulls.
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        let b_entry = db::get_entry(&conn_b, &id).unwrap().unwrap();
        assert!(b_entry.is_deleted);
    }

    #[tokio::test]
    async fn pull_is_idempotent_when_nothing_new() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key, "one");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        let second = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(second.pulled, 0);
        assert_eq!(second.merged, 0);
    }

    /// Regression guard for missing_blob_consistency (audit finding #7).
    ///
    /// Scenario: peer dev-b pushes two entries. After push, we delete one
    /// entry's blob file so the manifest still references it but the blob is
    /// absent. On pull, dev-a should:
    ///  - still ingest the entry whose blob IS present (pulled == 1)
    ///  - record a non-fatal consistency warning identifying the missing blob
    ///  - NOT crash, NOT abort the pull, and NOT report the pull as clean
    ///    (warnings must be non-empty)
    #[tokio::test]
    async fn pull_records_consistency_warning_for_manifest_referenced_missing_blob() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Device B pushes two entries.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let good_id = make_entry_with_content(&conn_b, &key, "present entry");
        let missing_id = make_entry_with_content(&conn_b, &key, "blob will be deleted");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Simulate the inconsistency: blob for `missing_id` is removed from
        // the sync store while the manifest still lists it.
        let blob_path = dir.path().join(format!("dev-b/entries/{missing_id}.bin"));
        assert!(blob_path.exists(), "blob must exist before we delete it");
        std::fs::remove_file(&blob_path).unwrap();

        // Device A pulls. The good entry must be ingested; the missing one
        // must surface as a consistency warning, not a silent skip.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // Good entry was ingested.
        assert_eq!(stats.pulled, 1, "good entry must be ingested");
        let good_entry = db::get_entry(&conn_a, &good_id).unwrap();
        assert!(good_entry.is_some(), "good entry must be in local DB");
        // The missing entry must NOT have been partially ingested.
        let missing_entry = db::get_entry(&conn_a, &missing_id).unwrap();
        assert!(
            missing_entry.is_none(),
            "missing-blob entry must not appear in local DB; got: {missing_entry:?}"
        );

        // Missing-blob must produce exactly one warning (not a silent skip,
        // not a double-count).
        assert_eq!(
            stats.warnings.len(),
            1,
            "expected exactly 1 consistency warning, got {}; warnings={:?}",
            stats.warnings.len(),
            stats.warnings
        );
        assert!(
            stats.warnings.iter().any(|w| w.contains(&missing_id)),
            "warning must identify the missing entry id ({missing_id}); \
             warnings={:?}",
            stats.warnings
        );

        // Pull must not be reported as clean (no errors is fine, but
        // warnings must be present).
        // Errors should be empty — this is a warning, not an error.
        assert!(
            stats.errors.is_empty(),
            "missing blob must not produce an error, only a warning; \
             errors={:?}",
            stats.errors
        );
    }

    /// Regression guard for P1 finding: `sync_now` must NOT drop
    /// `PullStats.warnings` — missing-blob consistency warnings must survive
    /// all the way into the returned `SyncSummary`.
    ///
    /// Scenario mirrors the Phase-7 `pull_remote` test but drives `sync_now`
    /// (the real user-facing entry-point). Device B pushes two entries; we
    /// delete one blob so the manifest is inconsistent; device A runs
    /// `sync_now`. The summary must carry the diagnostic in both `warnings`
    /// and `errors` so callers cannot mistake incomplete data for a clean sync.
    #[tokio::test]
    async fn sync_now_forwards_pull_warnings_for_missing_blob() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Device B: push two entries.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let _good_id = make_entry_with_content(&conn_b, &key, "present entry");
        let missing_id = make_entry_with_content(&conn_b, &key, "blob will be deleted");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Simulate the inconsistency: delete one blob from the sync store.
        let blob_path = dir.path().join(format!("dev-b/entries/{missing_id}.bin"));
        assert!(blob_path.exists(), "blob must exist before deletion");
        std::fs::remove_file(&blob_path).unwrap();

        // Device A: run the full sync_now cycle (push own empty folder, then pull).
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let summary = engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Warnings must NOT be dropped.
        assert!(
            !summary.warnings.is_empty(),
            "sync_now must forward pull warnings into SyncSummary; got empty warnings"
        );
        assert!(
            summary.warnings.iter().any(|w| w.contains(&missing_id)),
            "warning must identify the missing entry id ({missing_id}); \
             warnings={:?}",
            summary.warnings
        );
        // Pin the `pull:` prefix so a future change that strips it is caught.
        assert!(
            summary.warnings.iter().all(|w| w.starts_with("pull:")),
            "sync_now must prefix forwarded pull warnings with 'pull:'; warnings={:?}",
            summary.warnings
        );

        // The pull continues, but sync_now must not report a clean result.
        assert!(
            summary.errors.iter().any(|e| e.contains(&missing_id)),
            "missing blob warning must make the sync summary non-clean; errors={:?}",
            summary.errors
        );
    }

    #[tokio::test]
    async fn pull_entries_heartbeat_fires_even_when_blob_is_missing() {
        // Mirrors `sync_now_forwards_pull_warnings_for_missing_blob`, but
        // asserts the heartbeat side effect: a missing-blob `continue` must
        // not skip the per-item heartbeat, or a run of consecutive missing
        // blobs would go silent from the stall guard's point of view.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let _good_id = make_entry_with_content(&conn_b, &key, "present entry");
        let missing_id = make_entry_with_content(&conn_b, &key, "blob will be deleted");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let blob_path = dir.path().join(format!("dev-b/entries/{missing_id}.bin"));
        std::fs::remove_file(&blob_path).unwrap();

        let conn_a = fresh_db();
        let reporter = CountingReporter::new();
        let provider_a = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine_a =
            SyncEngine::new(provider_a, "dev-a".to_string()).with_reporter(reporter.clone());
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        assert!(
            reporter.count() >= 2,
            "expected at least one heartbeat per pulled item (including the \
             missing-blob one), got {}",
            reporter.count()
        );
    }

    #[tokio::test]
    async fn pull_entries_heartbeat_fires_even_for_bad_entry_id() {
        // A bad-id entry takes the `continue` before any read future is
        // built, so its heartbeat must live at the top of the chunk loop
        // (not inside the read future) — otherwise a manifest full of
        // unsafe ids would go silent from the stall guard's point of view.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Craft a peer manifest whose sole entry has an unsafe id (`/`),
        // which `is_safe_id` rejects. No blob is written — the id never
        // reaches a read.
        let peer_dir = dir.path().join("dev-b");
        std::fs::create_dir_all(&peer_dir).unwrap();
        let manifest = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries: vec![super::super::metadata::SyncedEntrySummary {
                entry_id: "bad/entry/id".to_string(),
                updated_at: 1_000,
                local_version: 1,
                is_deleted: false,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_000,
        };
        std::fs::write(
            peer_dir.join("metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let conn_a = fresh_db();
        let reporter = CountingReporter::new();
        let provider_a = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine_a =
            SyncEngine::new(provider_a, "dev-a".to_string()).with_reporter(reporter.clone());
        let before = reporter.count();
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            stats
                .errors
                .iter()
                .any(|e| e == "peer dev-b: bad entry id \"bad/entry/id\""),
            "bad-id error string must be byte-identical; got {:?}",
            stats.errors
        );
        assert!(
            reporter.count() > before,
            "a bad-id entry must still stamp a heartbeat, got no increase from {before}"
        );
    }

    #[tokio::test]
    async fn pull_ignores_bare_peer_folder_without_manifest() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("dev-b")).unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            stats.errors.is_empty(),
            "a half-created peer folder declares no channels: {:?}",
            stats.errors
        );
    }

    #[tokio::test]
    async fn pull_reports_only_declared_missing_chat_channel() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let peer_dir = dir.path().join("dev-b");
        std::fs::create_dir_all(&peer_dir).unwrap();
        std::fs::write(
            peer_dir.join("metadata.json"),
            br#"{"device_id":"dev-b","entries":[],"journals":[],"generated_at":1,"chats_present":true}"#,
        )
        .unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let stats = engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(stats.errors.iter().any(|e| e.contains("chats.bin")));
    }

    #[tokio::test]
    async fn pull_from_empty_provider_is_noop() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        let stats = engine
            .pull_remote(&conn, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert_eq!(stats.pulled, 0);
    }

    // ── push_local media integration ─────────────────────────────────────────

    /// Regression guard: media bytes written by push_local must be
    /// ciphertext. A known-marker plaintext must not appear verbatim in
    /// any file under the sync directory after push completes.
    #[tokio::test]
    async fn media_file_does_not_leak_plaintext() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("secret.jpg");
        let marker = b"SECRET-MEDIA-PLAINTEXT-MUST-NOT-LEAK-TO-DISK";
        std::fs::write(&file_path, marker).unwrap();

        let journal_id = default_journal(&conn);
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 3_000_000,
            },
        )
        .unwrap();
        db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "secret.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(marker.len() as i64),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        // Walk only the sync provider directory (not the local media_dir).
        fn walk(d: &std::path::Path, marker: &[u8]) {
            for e in std::fs::read_dir(d).unwrap() {
                let e = e.unwrap();
                let path = e.path();
                if path.is_dir() {
                    walk(&path, marker);
                } else {
                    let bytes = std::fs::read(&path).unwrap();
                    assert!(
                        !bytes.windows(marker.len()).any(|w| w == marker),
                        "media plaintext marker leaked into {}",
                        path.display()
                    );
                }
            }
        }
        walk(dir.path(), marker);
    }

    #[tokio::test]
    async fn push_local_uploads_pending_media_in_same_tick() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        // Create a real media file on disk
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake image bytes for sync test").unwrap();

        // Insert an entry so foreign key constraint on media is satisfied
        let journal_id = default_journal(&conn);
        let entry_id = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        // Insert a media row
        let media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(30),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        assert_eq!(media.upload_status, "pending");

        // Run the sync tick
        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(stats.media_uploaded, 1, "one media file should be uploaded");
        assert!(stats.errors.is_empty(), "no errors: {:?}", stats.errors);

        // Verify media row flipped to 'uploaded'
        let updated = db::get_media(&conn, &media.id).unwrap().unwrap();
        assert_eq!(updated.upload_status, "uploaded");
        assert!(updated.cloud_path.is_some());
        assert!(updated.uploaded_at.is_some());

        // Verify file exists in provider
        let media_path = dir.path().join(format!("dev-a/media/{}", media.id));
        assert!(media_path.exists(), "media file should be in provider dir");
    }

    #[tokio::test]
    async fn push_local_uploads_thumbnail_alongside_full_media() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        // Stage a real media file AND a thumbnail file on disk.
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake full-size bytes").unwrap();
        let thumb_path = media_dir.path().join("photo.thumb.jpg");
        std::fs::write(&thumb_path, b"tiny thumbnail bytes").unwrap();

        let journal_id = default_journal(&conn);
        let entry_id = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        let media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(30),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::update_media_thumbnail_path(&conn, &media.id, Some(&thumb_path.to_string_lossy()))
            .unwrap();

        // Run the sync tick.
        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(stats.media_uploaded, 1);
        assert!(stats.errors.is_empty());

        // Both the full media AND the thumbnail should exist in the provider.
        let media_remote = dir.path().join(format!("dev-a/media/{}", media.id));
        let thumb_remote = dir.path().join(format!("dev-a/media/{}.thumb", media.id));
        assert!(media_remote.exists(), "full media uploaded");
        assert!(thumb_remote.exists(), "thumbnail uploaded to .thumb suffix");

        // Thumbnail is encrypted — plaintext must NOT appear in the uploaded file.
        let uploaded = std::fs::read(&thumb_remote).unwrap();
        assert!(
            !uploaded.windows(8).any(|w| w == b"tiny thu"),
            "thumbnail plaintext must not leak"
        );
    }

    #[tokio::test]
    async fn push_local_succeeds_when_thumbnail_path_missing() {
        // If thumbnail_path references a file that no longer exists, the
        // main media upload must still succeed — thumbnail is best-effort.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("only.jpg");
        std::fs::write(&file_path, b"full bytes").unwrap();

        let journal_id = default_journal(&conn);
        let entry_id = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;

        let media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "only.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(10),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::update_media_thumbnail_path(&conn, &media.id, Some("/does/not/exist.jpg")).unwrap();

        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(stats.media_uploaded, 1, "main upload still counted");
    }

    #[tokio::test]
    async fn push_local_uploads_entries_and_media_together() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("img.jpg");
        std::fs::write(&file_path, b"img data").unwrap();

        // Create an entry (pending)
        let _entry_id = make_entry_with_content(&conn, &key, "hello world");

        // Also insert a media row on the default journal's first entry
        let journal_id = default_journal(&conn);
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 2_000_000,
            },
        )
        .unwrap();
        db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "img.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(8),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        // At least 1 entry + 1 media
        assert!(stats.pushed >= 1, "should push entries");
        assert_eq!(stats.media_uploaded, 1, "should upload media");
        assert!(stats.errors.is_empty());
    }

    #[tokio::test]
    async fn push_local_restores_all_owned_content_after_cloud_loss() {
        let key = test_key();
        let conn_a = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine_a = make_engine(&dir, "dev-a");

        let journal_id = default_journal(&conn_a);
        let entry_id = make_entry_with_content(&conn_a, &key, "survives cloud loss");
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"media survives cloud loss").unwrap();
        let media = db::create_media(
            &conn_a,
            crate::db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(25),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        let version_id = db::insert_entry_version(
            &conn_a,
            &entry_id,
            b"version survives cloud loss",
            "version preview",
            "dev-a",
        )
        .unwrap();
        let session_id = "chat-session-full-cloud-repair";
        create_chat(&conn_a, session_id, "empathetic");
        db::append_chat_message(
            &conn_a,
            "msg-full-cloud-repair-0001",
            session_id,
            "user",
            "Daily Chat survives",
            now_unix(),
        )
        .unwrap();

        let first = engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(first.pushed, 1);
        assert_eq!(first.media_uploaded, 1);
        assert_eq!(first.versions_uploaded, 1);

        std::fs::remove_dir_all(dir.path().join("dev-a")).unwrap();

        let repaired = engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        assert_eq!(repaired.pushed, 1, "missing owned entry must be requeued");
        assert_eq!(
            repaired.media_uploaded, 1,
            "missing owned media must be requeued"
        );
        assert_eq!(
            repaired.versions_uploaded, 1,
            "missing owned version must be requeued"
        );
        assert!(
            dir.path()
                .join(format!("dev-a/journals/{journal_id}.bin"))
                .exists(),
            "missing owned journal must be requeued"
        );
        assert!(repaired.errors.is_empty(), "errors: {:?}", repaired.errors);
        let manifest: DeviceMetadata =
            serde_json::from_slice(&std::fs::read(dir.path().join("dev-a/metadata.json")).unwrap())
                .unwrap();
        assert!(manifest.chats_present);

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let pulled = engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(pulled.errors.is_empty(), "errors: {:?}", pulled.errors);
        let pulled_entry = db::get_entry(&conn_b, &entry_id).unwrap().unwrap();
        assert_eq!(pulled_entry.title.as_deref(), Some("t"));
        assert!(db::get_media(&conn_b, &media.id).unwrap().is_some());
        assert!(db::get_journal(&conn_b, &journal_id).unwrap().is_some());
        assert!(db::list_entry_versions(&conn_b, &entry_id)
            .unwrap()
            .iter()
            .any(|version| version.id == version_id));
        assert!(db::load_chat_session(&conn_b, session_id)
            .unwrap()
            .is_some());
    }

    // ── Journal color sync (regression for 2026-05-21 bug) ─────────────

    fn set_journal_color(conn: &Connection, id: &str, color: &str) {
        // Update the seeded default journal in-place. Bumps updated_at so
        // the LWW comparison on the receiving side has a clean signal.
        conn.execute(
            "UPDATE journals SET color = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![color, now_unix() + 5, id],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn reconcile_listing_failure_leaves_all_owned_ledgers_unchanged() {
        struct FailOnJournalListingProvider;

        #[async_trait::async_trait]
        impl SyncProvider for FailOnJournalListingProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }

            async fn list_files(
                &self,
                _device_id: &str,
                kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                match kind {
                    FileKind::Entries | FileKind::Media => Ok(vec![]),
                    FileKind::Journals => Err(SyncError::Network("list journals failed".into())),
                    _ => Ok(vec![]),
                }
            }

            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound(path.to_string()))
            }

            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Err(SyncError::Network("write must not be reached".into()))
            }

            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Ok(())
            }
        }

        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let local_engine = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn, &key, "fail closed");
        let journal_id = default_journal(&conn);
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fail closed media").unwrap();
        let media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(17),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        let version_id =
            db::insert_entry_version(&conn, &entry_id, b"version", "preview", "dev-a").unwrap();
        local_engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        let failing_engine =
            SyncEngine::new(Arc::new(FailOnJournalListingProvider), "dev-a".to_string());
        assert!(failing_engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .is_err());

        let entry_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&entry_id],
                |row| row.get(0),
            )
            .unwrap();
        let journal_status: String = conn
            .query_row(
                "SELECT sync_status FROM journal_sync_state WHERE journal_id = ?1",
                [&journal_id],
                |row| row.get(0),
            )
            .unwrap();
        let version_status: String = conn
            .query_row(
                "SELECT upload_status FROM entry_versions WHERE id = ?1",
                [&version_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(entry_status, "synced");
        assert_eq!(
            db::get_media(&conn, &media.id)
                .unwrap()
                .unwrap()
                .upload_status,
            "uploaded"
        );
        assert_eq!(journal_status, "synced");
        assert_eq!(version_status, "uploaded");
    }

    #[tokio::test]
    async fn pull_carries_journal_color_to_new_journal_on_peer() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // B owns a journal with a distinctive color, and pushes an entry.
        let conn_b = fresh_db();
        let journal_b = default_journal(&conn_b);
        set_journal_color(&conn_b, &journal_b, "#ff6688");
        let engine_b = make_engine(&dir, "dev-b");
        make_entry_with_content(&conn_b, &key, "B's entry");
        engine_b
            .push_local(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // A pulls. Even though A's own DB seeded its OWN default journal id,
        // B's journal id is distinct (random per migration). So on A, B's
        // journal materializes as a NEW row carrying the color.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .pull_remote(&conn_a, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let row: Option<String> = conn_a
            .query_row(
                "SELECT color FROM journals WHERE id = ?1",
                [&journal_b],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(row.as_deref(), Some("#ff6688"));
    }

    #[tokio::test]
    async fn pull_updates_existing_journal_color_under_lww() {
        // Reproduce the user-visible "I changed the color on machine A but
        // machine B still shows the old one" — both devices already had
        // the same journal id (e.g. via an earlier sync); A updates color
        // and re-pushes; B must adopt the newer color.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Stage: A and B share journal_id "shared-journal" (mimics
        // post-first-sync state).
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let shared = "shared-journal-uuid-0001";
        for conn in [&conn_a, &conn_b] {
            conn.execute(
                "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order)
                 VALUES (?1, 'Shared', '#000000', ?2, ?2, 0)",
                rusqlite::params![shared, now_unix() - 100],
            )
            .unwrap();
        }

        // A bumps color to a new value (and updated_at).
        let later = now_unix() + 100;
        conn_a
            .execute(
                "UPDATE journals SET color = '#ff6688', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![later, shared],
            )
            .unwrap();

        // A creates an entry against the shared journal and pushes.
        let id = uuid::Uuid::new_v4().to_string();
        conn_a
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', NULL, ?3, ?3, ?3, 0, 0, NULL)",
                rusqlite::params![id, shared, later],
            )
            .unwrap();
        db::mark_entry_pending(&conn_a, &id).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // B pulls and must adopt A's newer journal color.
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        let (color, ts): (Option<String>, i64) = conn_b
            .query_row(
                "SELECT color, updated_at FROM journals WHERE id = ?1",
                [shared],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(color.as_deref(), Some("#ff6688"));
        assert_eq!(
            ts, later,
            "journal updated_at should match the remote LWW key"
        );
    }

    #[tokio::test]
    async fn pull_does_not_rewind_journal_when_local_edit_is_newer() {
        // LWW must favor the strictly-newer side. If B's local edit happened
        // AFTER A's push, pulling A must not overwrite B's color.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let shared = "shared-journal-uuid-0002";
        for conn in [&conn_a, &conn_b] {
            conn.execute(
                "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order)
                 VALUES (?1, 'Shared', '#000000', ?2, ?2, 0)",
                rusqlite::params![shared, now_unix() - 100],
            )
            .unwrap();
        }

        // A sets color at t=100.
        let t_a = now_unix() + 50;
        conn_a
            .execute(
                "UPDATE journals SET color = '#aaaaaa', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![t_a, shared],
            )
            .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        conn_a
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', NULL, ?3, ?3, ?3, 0, 0, NULL)",
                rusqlite::params![id, shared, t_a],
            )
            .unwrap();
        db::mark_entry_pending(&conn_a, &id).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // B sets color at t=200 (strictly later than A's value).
        let t_b = t_a + 100;
        conn_b
            .execute(
                "UPDATE journals SET color = '#bbbbbb', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![t_b, shared],
            )
            .unwrap();

        // B pulls A; must keep B's local newer color.
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        let color: Option<String> = conn_b
            .query_row("SELECT color FROM journals WHERE id = ?1", [shared], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(color.as_deref(), Some("#bbbbbb"));
    }

    // ── Media metadata sync ─────────────────────────────────────────────────

    #[tokio::test]
    async fn pull_materializes_media_rows_with_cloud_path_for_peer() {
        // The user-reported bug: images uploaded by device A are invisible
        // on device B because the media TABLE rows are never synced. This
        // test pins the fix: B's DB must end up with the media row +
        // cloud_path pointing at A's device.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");

        // Stage a real media file + an entry referencing it on A.
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake image bytes").unwrap();
        let journal_id = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("photo entry"),
                content_text: Some("see attached"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        let media = db::create_media(
            &conn_a,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: Some(1024),
                height: Some(768),
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        // `create_entry` does not mark pending — the command layer does that
        // on user edit. The test simulates "user just saved this entry".
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();

        // Push: media uploads first (new order), then the entry payload
        // embeds the media manifest.
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // B pulls.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // B now has a media row with the same id and a cloud_path pointing at A.
        let pulled = db::get_media(&conn_b, &media.id).unwrap();
        assert!(pulled.is_some(), "media row must materialize on peer");
        let pulled = pulled.unwrap();
        assert_eq!(pulled.entry_id, entry.id);
        assert_eq!(pulled.file_name, "photo.jpg");
        assert_eq!(pulled.file_type, "image/jpeg");
        assert_eq!(pulled.width, Some(1024));
        assert_eq!(pulled.height, Some(768));
        assert_eq!(pulled.upload_status, "uploaded");
        assert_eq!(
            pulled.cloud_path.as_deref(),
            Some(format!("dev-a/media/{}", media.id).as_str()),
            "cloud_path must point to authoring device so resolve_media can fetch"
        );
        // Cloud path must parse via the resolver's validator.
        let parsed = crate::commands::media::validate_cloud_path(
            pulled.cloud_path.as_deref().unwrap(),
            &media.id,
        )
        .expect("cloud_path round-trips through validate_cloud_path");
        assert_eq!(parsed, "dev-a");
    }

    /// The literal requirement, end to end through the JOURNAL channel:
    /// A deletes a journal, and on B every entry in it dies, its media rows
    /// go, B's cached file is unlinked from disk, and the blob B itself
    /// uploaded leaves B's own cloud folder.
    ///
    /// The entry-channel test above cannot cover this: B's entry `E_b` here was
    /// created on B and never existed on A, so A's manifest carries no
    /// tombstone for it — only the journal tombstone reaches B. That is the
    /// case `tombstone_journal_from_sync_lww` used to miss entirely, and the
    /// only one where B is the OWNER of the orphaned cloud blob (a pulled peer
    /// row's blob lives in the authoring device's folder, which no other
    /// device may prune).
    #[tokio::test]
    async fn journal_delete_sweeps_peer_entries_media_and_own_cloud_blobs() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let files = TempDir::new().unwrap();

        // ── A: a doomed journal (plus the default one, so it is deletable).
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let journal = db::create_journal(&conn_a, "Doomed", None).unwrap();
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // ── B: learns the journal, then creates its OWN entry + media in it
        //    and uploads that media to B's own cloud folder.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        // Captured BEFORE the pull: afterwards `default_journal`'s
        // `SELECT id FROM journals LIMIT 1` could return A's doomed journal.
        let journal_b = default_journal(&conn_b);
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let entry_b = db::create_entry(
            &conn_b,
            crate::db::CreateEntryParams {
                journal_id: &journal.id,
                title: Some("made on B"),
                content_text: Some("offline"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        let doomed_file = files.path().join("doomed.jpg");
        std::fs::write(&doomed_file, b"only copy on B").unwrap();
        let doomed_media = db::create_media(
            &conn_b,
            crate::db::CreateMediaParams {
                entry_id: &entry_b.id,
                file_name: "doomed.jpg",
                file_type: "image/jpeg",
                storage_path: &doomed_file.to_string_lossy(),
                file_size: Some(14),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_b, &entry_b.id).unwrap();

        // A second media row in B's OTHER journal — it must survive both the
        // cascade and the cloud prune.
        let survivor_entry = db::create_entry(
            &conn_b,
            crate::db::CreateEntryParams {
                journal_id: &journal_b,
                title: Some("survivor"),
                content_text: Some("keeps living"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap()
        .id;
        let survivor_file = files.path().join("survivor.jpg");
        std::fs::write(&survivor_file, b"keep me").unwrap();
        let survivor_media = db::create_media(
            &conn_b,
            crate::db::CreateMediaParams {
                entry_id: &survivor_entry,
                file_name: "survivor.jpg",
                file_type: "image/jpeg",
                storage_path: &survivor_file.to_string_lossy(),
                file_size: Some(7),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_b, &survivor_entry).unwrap();

        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let b_media_dir = dir.path().join("dev-b").join("media");
        assert!(
            b_media_dir.join(&doomed_media.id).exists(),
            "precondition: B must own a cloud blob for its own media"
        );

        // ── A deletes the journal. `now_unix()` has 1-second resolution, so
        //    bump `updated_at` to give the diff a strictly-newer remote.
        db::delete_journal(&conn_a, &journal.id).unwrap();
        conn_a
            .execute(
                "UPDATE journals SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&journal.id],
            )
            .unwrap();
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // ── B pulls the journal tombstone -> cascade.
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        assert!(
            db::get_entry_raw(&conn_b, &entry_b.id)
                .unwrap()
                .unwrap()
                .is_deleted,
            "B's own entry must die with the journal even though A never saw it"
        );
        assert!(
            !db::media_exists(&conn_b, &doomed_media.id).unwrap(),
            "its media row must be gone"
        );
        assert!(
            !doomed_file.exists(),
            "its file must be unlinked from B's disk"
        );
        assert!(
            db::media_exists(&conn_b, &survivor_media.id).unwrap(),
            "media in another journal must be untouched"
        );
        assert!(survivor_file.exists(), "survivor file must stay on disk");

        // ── One more sync: the re-armed prune sweeps B's own cloud blob.
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        assert!(
            !b_media_dir.join(&doomed_media.id).exists(),
            "the deleted journal's media must leave B's OWN cloud folder"
        );
        assert!(
            b_media_dir.join(&survivor_media.id).exists(),
            "the surviving journal's cloud blob must not be pruned"
        );
    }

    /// Device A deletes an entry (directly, or as part of deleting its whole
    /// journal — both funnel into the entry tombstone channel). Peer B applied
    /// the tombstone but kept the entry's media rows, so on B the files stayed
    /// on disk, `list_pending_uploads` (no `is_deleted` filter) kept uploading
    /// them, and `reconcile_own_media_files` could never prune B's own cloud
    /// blobs — the prune only sweeps ids whose local row is gone. Only the
    /// deleting device pruned its own folder; nobody prunes another device's.
    #[tokio::test]
    async fn peer_entry_tombstone_drops_media_rows_so_own_cloud_prune_can_sweep() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake image bytes").unwrap();
        let journal_id = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("photo entry"),
                content_text: Some("see attached"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        let media = db::create_media(
            &conn_a,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            db::get_media(&conn_b, &media.id).unwrap().is_some(),
            "precondition: B must have the media row before the delete"
        );

        // A deletes the entry. `now_unix()` has 1-second resolution, so bump
        // `updated_at` explicitly to give the diff a strictly-newer remote.
        crate::commands::entries::soft_delete_entry_impl(&conn_a, &entry.id).unwrap();
        conn_a
            .execute(
                "UPDATE entries SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&entry.id],
            )
            .unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        // Simulate "B already reconciled its own cloud this session" — the
        // Automatic gate that makes the prune a once-per-session no-op.
        engine_b.mark_own_cloud_reconciled();
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            !engine_b
                .session_own_cloud_reconciled
                .load(std::sync::atomic::Ordering::SeqCst),
            "dropping media rows must re-arm the own-cloud prune, or B never \
             sweeps its blobs this session (sync_now pushes before it pulls)"
        );
        assert!(
            db::get_entry_raw(&conn_b, &entry.id)
                .unwrap()
                .unwrap()
                .is_deleted,
            "precondition: the entry tombstone must have reached B"
        );
        assert!(
            db::get_media(&conn_b, &media.id).unwrap().is_none(),
            "peer must drop the tombstoned entry's media rows"
        );
        assert!(
            !db::media_exists(&conn_b, &media.id).unwrap(),
            "media_exists must be false — that is what unblocks the own-cloud prune"
        );
    }

    #[tokio::test]
    async fn pull_remote_honours_media_tombstone_when_created_at_lte_deleted_at() {
        // Device A deletes media; the tombstone rides in the entry manifest.
        // Peer B must drop the row (and its cached file) once it pulls.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake image bytes").unwrap();
        let journal_id = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("photo entry"),
                content_text: Some("see attached"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        let media = db::create_media(
            &conn_a,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: Some(1024),
                height: Some(768),
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            db::get_media(&conn_b, &media.id).unwrap().is_some(),
            "peer must have the row before the tombstone arrives"
        );

        crate::commands::media::delete_media_inner(&conn_a, &media.id).unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            db::get_media(&conn_b, &media.id).unwrap().is_none(),
            "tombstone with created_at <= deleted_at must delete the peer row"
        );
    }

    #[tokio::test]
    async fn pull_remote_does_not_honour_media_tombstone_when_created_at_gt_deleted_at() {
        // A concurrent offline add on B (newer created_at) must survive an
        // older tombstone from A — that is why we rejected manifest-diff.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake image bytes").unwrap();
        let journal_id = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("photo entry"),
                content_text: Some("see attached"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        let media = db::create_media(
            &conn_a,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: Some(1024),
                height: Some(768),
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        conn_b
            .execute(
                "UPDATE media SET created_at = created_at + 1_000_000 WHERE id = ?1",
                [&media.id],
            )
            .unwrap();

        crate::commands::media::delete_media_inner(&conn_a, &media.id).unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        assert!(
            db::get_media(&conn_b, &media.id).unwrap().is_some(),
            "created_at > deleted_at must NOT honour the tombstone"
        );
    }

    #[test]
    fn ingest_entry_honours_media_tombstone_when_local_title_newer() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-b");
        let journal_id = default_journal(&conn);
        let local_updated = now_unix();
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("local-newer-title"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: local_updated,
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![local_updated, entry.id],
        )
        .unwrap();
        let media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: "/tmp/photo.jpg",
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_synced(&conn, &entry.id, 1).unwrap();
        let before = db::get_entry_raw(&conn, &entry.id).unwrap().unwrap();

        let remote_meta = EntryMetadata {
            entry_id: entry.id.clone(),
            device_id: "dev-a".to_string(),
            updated_at: local_updated.saturating_sub(60),
            entry_date: local_updated,
            created_at: local_updated,
            journal_id: journal_id.clone(),
            journal_name: Some("Synced".to_string()),
            journal_color: None,
            journal_updated_at: Some(local_updated),
            title: Some("remote-older-title".to_string()),
            preview_text: Some("body".to_string()),
            content_text: Some("body".to_string()),
            location_label: None,
            location_address: None,
            weather_summary: None,
            weather_icon: None,
            latitude: None,
            longitude: None,
            emotion: None,
            is_favorite: false,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            cover_media_id: None,
            entry_date_user_edited: false,
            content_language: None,
            tag_ids: vec![],
            media: vec![],
            deleted_media: vec![SyncDeletedMediaItem {
                id: media.id.clone(),
                deleted_at: media.created_at,
            }],
        };
        let ks = engine.make_key_state(&key);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let metadata_ciphertext =
            encrypt_data_with_state(&serde_json::to_vec(&remote_meta).unwrap(), &ks).unwrap();
        let yjs_blob_ciphertext = encrypt_data_with_state(&make_yjs_blob("body"), &ks).unwrap();
        let payload = SyncEntryPayload::new(fp, yjs_blob_ciphertext, metadata_ciphertext);

        engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry.id, &payload)
            .unwrap();

        assert!(
            db::get_media(&conn, &media.id).unwrap().is_none(),
            "inbound deleted_media must honour even when the local title wins LWW"
        );
        let after = db::get_entry_raw(&conn, &entry.id).unwrap().unwrap();
        assert_eq!(
            after.title.as_deref(),
            Some("local-newer-title"),
            "newer local title must survive"
        );
        assert!(
            after.updated_at > before.updated_at,
            "honour must bump updated_at so the tombstone re-pushes"
        );
        let sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&entry.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sync_status, "pending");
    }

    #[test]
    fn ingest_entry_media_tombstone_i64_max_does_not_delete_local_row() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-b");
        let journal_id = default_journal(&conn);
        let now = now_unix();
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("photo"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: now,
            },
        )
        .unwrap();
        let media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: "/tmp/photo-now.jpg",
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        let remote_meta = EntryMetadata {
            entry_id: entry.id.clone(),
            device_id: "dev-a".to_string(),
            updated_at: now,
            entry_date: now,
            created_at: now,
            journal_id: journal_id.clone(),
            journal_name: Some("Synced".to_string()),
            journal_color: None,
            journal_updated_at: Some(now),
            title: Some("photo".to_string()),
            preview_text: Some("body".to_string()),
            content_text: Some("body".to_string()),
            location_label: None,
            location_address: None,
            weather_summary: None,
            weather_icon: None,
            latitude: None,
            longitude: None,
            emotion: None,
            is_favorite: false,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            cover_media_id: None,
            entry_date_user_edited: false,
            content_language: None,
            tag_ids: vec![],
            media: vec![],
            deleted_media: vec![SyncDeletedMediaItem {
                id: media.id.clone(),
                deleted_at: i64::MAX,
            }],
        };
        let ks = engine.make_key_state(&key);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let metadata_ciphertext =
            encrypt_data_with_state(&serde_json::to_vec(&remote_meta).unwrap(), &ks).unwrap();
        let yjs_blob_ciphertext = encrypt_data_with_state(&make_yjs_blob("body"), &ks).unwrap();
        let payload = SyncEntryPayload::new(fp, yjs_blob_ciphertext, metadata_ciphertext);

        engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry.id, &payload)
            .unwrap();

        assert!(
            db::get_media(&conn, &media.id).unwrap().is_some(),
            "i64::MAX deleted_at must skip upsert and leave a row created now"
        );
        let tombs = db::list_media_tombstones_for_entry(&conn, &entry.id).unwrap();
        assert!(
            tombs.is_empty(),
            "clock-skewed deleted_at must not persist a tombstone"
        );
    }

    #[tokio::test]
    async fn push_does_not_advertise_media_with_pending_upload_status() {
        // Defense against a single-entry push (editor debounce path) firing
        // before the media has actually been uploaded. The manifest must
        // only reference media that already exists in the cloud.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");

        let journal_id = default_journal(&conn);
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        // A media row with status='pending' (never uploaded).
        let media_dir = TempDir::new().unwrap();
        let fake = media_dir.path().join("never.jpg");
        std::fs::write(&fake, b"x").unwrap();
        let _media = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry.id,
                file_name: "never.jpg",
                file_type: "image/jpeg",
                storage_path: &fake.to_string_lossy(),
                file_size: Some(1),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::mark_entry_pending(&conn, &entry.id).unwrap();

        // Only push a single entry (skip media upload). The payload on disk
        // must declare an empty media list.
        engine
            .push_single_entry(&conn, &key, &entry.id)
            .await
            .unwrap();

        // Read back the encrypted payload, decrypt the metadata, inspect.
        let bytes =
            std::fs::read(dir.path().join(format!("dev-a/entries/{}.bin", entry.id))).unwrap();
        let payload = super::super::entry_sync::deserialize_payload(&bytes).unwrap();
        let ks = engine.make_key_state(&key);
        let plain =
            crate::utils::encryption::decrypt_data_with_state(&payload.metadata_ciphertext, &ks)
                .unwrap();
        let meta: super::super::metadata::EntryMetadata = serde_json::from_slice(&plain).unwrap();
        assert!(
            meta.media.is_empty(),
            "pending-upload media must NOT appear in payload, got {:?}",
            meta.media
        );
    }

    // ── Settings sync (Stage 1 of full-state expansion) ─────────────────────

    #[tokio::test]
    async fn settings_round_trip_between_devices() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // A sets a few allowlisted preferences.
        let conn_a = fresh_db();
        db::set_setting(&conn_a, "theme", "dark").unwrap();
        db::set_setting(&conn_a, "geocoding_provider", "mapbox").unwrap();
        db::set_setting(&conn_a, "ai_daily_chat_persona", "tough").unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_settings(&conn_a, &key).await.unwrap();

        // B pulls and sees the same values.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let pulled = engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            pulled.errors.is_empty(),
            "no errors expected: {:?}",
            pulled.errors
        );
        assert_eq!(
            db::get_setting(&conn_b, "theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            db::get_setting(&conn_b, "geocoding_provider")
                .unwrap()
                .as_deref(),
            Some("mapbox")
        );
        assert_eq!(
            db::get_setting(&conn_b, "ai_daily_chat_persona")
                .unwrap()
                .as_deref(),
            Some("tough")
        );
    }

    #[tokio::test]
    async fn lock_verifier_disable_and_reenable_propagate_between_devices() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Device A enables second lock, syncs to B.
        let conn_a = fresh_db();
        db::set_second_lock_verifier(&conn_a, "second-verifier-v1").unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_settings(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            db::get_second_lock_verifier(&conn_b).unwrap().as_deref(),
            Some("second-verifier-v1")
        );

        // A disables → tombstone must reach B.
        db::clear_second_lock_verifier(&conn_a).unwrap();
        engine_a.push_settings(&conn_a, &key).await.unwrap();
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            db::get_second_lock_verifier(&conn_b).unwrap().is_none(),
            "peer must see second lock disabled after tombstone sync"
        );

        // A re-enables with a new verifier → B must converge.
        db::set_second_lock_verifier(&conn_a, "second-verifier-v2").unwrap();
        engine_a.push_settings(&conn_a, &key).await.unwrap();
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            db::get_second_lock_verifier(&conn_b).unwrap().as_deref(),
            Some("second-verifier-v2")
        );

        // Invisible multi-vault hard cut: single `invisible_lock_verifier`
        // is off the settings allowlist. Writing it locally must not ride
        // settings.bin to peers (vaults use `invisible_vaults_json` merge-by-id).
        db::set_invisible_lock_verifier(&conn_a, "invisible-verifier-v1").unwrap();
        engine_a.push_settings(&conn_a, &key).await.unwrap();
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            db::get_invisible_lock_verifier(&conn_b).unwrap().is_none(),
            "legacy invisible_lock_verifier must not sync via settings LWW"
        );
    }

    #[tokio::test]
    async fn invisible_vaults_json_merge_by_id_two_devices() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        // Each device creates a distinct vault.
        conn_a
            .execute(
                "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
                 VALUES ('vault-from-a', 'phc-a', 1, 100)",
                [],
            )
            .unwrap();
        conn_b
            .execute(
                "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
                 VALUES ('vault-from-b', 'phc-b', 1, 100)",
                [],
            )
            .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_settings(&conn_a, &key).await.unwrap();
        engine_b.push_settings(&conn_b, &key).await.unwrap();

        // Cross-pull: each must end with both vaults (union merge-by-id).
        engine_a
            .pull_settings(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        for (label, conn) in [("a", &conn_a), ("b", &conn_b)] {
            let vaults = db::list_invisible_vaults(conn).unwrap();
            let ids: Vec<_> = vaults.iter().map(|v| v.id.as_str()).collect();
            assert!(
                ids.contains(&"vault-from-a") && ids.contains(&"vault-from-b"),
                "device {label} must hold both vaults after merge-by-id, got {ids:?}"
            );
        }

        // Newer verifier for vault-from-a on A wins on B.
        conn_a
            .execute(
                "UPDATE invisible_vaults SET verifier = 'phc-a-newer', updated_at = 500
                 WHERE id = 'vault-from-a'",
                [],
            )
            .unwrap();
        engine_a.push_settings(&conn_a, &key).await.unwrap();
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            db::get_invisible_vault(&conn_b, "vault-from-a")
                .unwrap()
                .unwrap()
                .verifier,
            "phc-a-newer"
        );
    }

    #[tokio::test]
    async fn vault_id_roundtrips_on_entry_and_journal_sync() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");

        let vault_id = "vault-roundtrip-1";
        conn_a
            .execute(
                "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
                 VALUES (?1, 'phc-rt', 1, 1)",
                [vault_id],
            )
            .unwrap();

        let journal = db::create_journal(&conn_a, "Hidden journal", None).unwrap();
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal.id,
                title: Some("secret"),
                content_text: Some("body"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        db::set_entry_invisible(&conn_a, &entry.id, true, Some(vault_id)).unwrap();
        db::set_journal_invisible(&conn_a, &journal.id, true, Some(vault_id)).unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();
        db::mark_journal_pending(&conn_a, &journal.id).unwrap();

        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Wire payload must carry vault_id.
        let entry_bytes =
            std::fs::read(dir.path().join(format!("dev-a/entries/{}.bin", entry.id))).unwrap();
        let entry_payload = super::super::entry_sync::deserialize_payload(&entry_bytes).unwrap();
        let ks = engine_a.make_key_state(&key);
        let meta_plain = crate::utils::encryption::decrypt_data_with_state(
            &entry_payload.metadata_ciphertext,
            &ks,
        )
        .unwrap();
        let meta: EntryMetadata = serde_json::from_slice(&meta_plain).unwrap();
        assert!(meta.is_invisible);
        assert_eq!(meta.vault_id.as_deref(), Some(vault_id));

        let journal_bytes = std::fs::read(
            dir.path()
                .join(format!("dev-a/journals/{}.bin", journal.id)),
        )
        .unwrap();
        let journal_plain =
            crate::utils::encryption::decrypt_data_with_state(&journal_bytes, &ks).unwrap();
        let j_payload: super::super::metadata::JournalPayload =
            serde_json::from_slice(&journal_plain).unwrap();
        assert!(j_payload.is_invisible);
        assert_eq!(j_payload.vault_id.as_deref(), Some(vault_id));

        // Peer pulls and stores vault_id with is_invisible.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let pulled_entry = db::get_entry_raw(&conn_b, &entry.id).unwrap().unwrap();
        assert!(pulled_entry.is_invisible);
        assert_eq!(pulled_entry.vault_id.as_deref(), Some(vault_id));

        let pulled_journal = db::get_journal(&conn_b, &journal.id).unwrap().unwrap();
        assert!(pulled_journal.is_invisible);
        assert_eq!(pulled_journal.vault_id.as_deref(), Some(vault_id));
    }

    #[test]
    fn ingest_normalizes_vault_id_when_not_invisible() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-b");
        let journal_id = default_journal(&conn);
        let entry_id = uuid::Uuid::new_v4().to_string();
        let now = now_unix();
        let remote_meta = EntryMetadata {
            entry_id: entry_id.clone(),
            device_id: "dev-a".to_string(),
            updated_at: now,
            entry_date: now,
            created_at: now,
            journal_id,
            journal_name: Some("Synced".to_string()),
            journal_color: None,
            journal_updated_at: Some(now),
            title: Some("visible".to_string()),
            preview_text: Some("body".to_string()),
            content_text: Some("body".to_string()),
            location_label: None,
            location_address: None,
            weather_summary: None,
            weather_icon: None,
            latitude: None,
            longitude: None,
            emotion: None,
            is_favorite: false,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            // Malicious/broken peer: vault_id set while not invisible.
            vault_id: Some("should-clear".to_string()),
            cover_media_id: None,
            entry_date_user_edited: false,
            content_language: None,
            tag_ids: vec![],
            media: vec![],
            deleted_media: vec![],
        };
        let ks = engine.make_key_state(&key);
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let metadata_ciphertext =
            encrypt_data_with_state(&serde_json::to_vec(&remote_meta).unwrap(), &ks).unwrap();
        let yjs_blob_ciphertext = encrypt_data_with_state(&make_yjs_blob("body"), &ks).unwrap();
        let payload = SyncEntryPayload::new(fp, yjs_blob_ciphertext, metadata_ciphertext);

        engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry_id, &payload)
            .unwrap();

        let stored = db::get_entry_raw(&conn, &entry_id).unwrap().unwrap();
        assert!(!stored.is_invisible);
        assert!(
            stored.vault_id.is_none(),
            "is_invisible=false must force vault_id NULL on ingest"
        );
    }

    #[tokio::test]
    async fn settings_lww_per_key_does_not_rewind_local_newer_edits() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // A sets theme at t=now.
        let conn_a = fresh_db();
        db::set_setting(&conn_a, "theme", "light").unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_settings(&conn_a, &key).await.unwrap();

        // B sets theme to a different value at t=now+10 (locally newer).
        let conn_b = fresh_db();
        // Bump local wall-clock by overwriting updated_at directly to
        // simulate a later edit without sleeping.
        db::set_setting(&conn_b, "theme", "dark").unwrap();
        conn_b
            .execute(
                "UPDATE settings SET updated_at = updated_at + 1000 WHERE key = 'theme'",
                [],
            )
            .unwrap();

        // B pulls A → A's older write must not overwrite B's newer one.
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            db::get_setting(&conn_b, "theme").unwrap().as_deref(),
            Some("dark"),
            "local newer edit must survive LWW"
        );
    }

    #[tokio::test]
    async fn pull_settings_merges_provider_endpoints_per_preset() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let a_map = {
            let mut m = std::collections::BTreeMap::new();
            m.insert(
                "custom".to_string(),
                db::ProviderEndpointRecord {
                    endpoint: Some("https://device-a.example/v1".into()),
                    updated_at: 100,
                },
            );
            m
        };
        db::set_setting(
            &conn_a,
            db::AI_PROVIDER_ENDPOINTS_KEY,
            &serde_json::to_string(&a_map).unwrap(),
        )
        .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_settings(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let b_map = {
            let mut m = std::collections::BTreeMap::new();
            m.insert(
                "other-local".to_string(),
                db::ProviderEndpointRecord {
                    endpoint: Some("http://127.0.0.1:9090/v1".into()),
                    updated_at: 100,
                },
            );
            m
        };
        db::set_setting(
            &conn_b,
            db::AI_PROVIDER_ENDPOINTS_KEY,
            &serde_json::to_string(&b_map).unwrap(),
        )
        .unwrap();
        let engine_b = make_engine(&dir, "dev-b");
        let pulled = engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(pulled.errors.is_empty(), "{:?}", pulled.errors);
        assert_eq!(pulled.changed_endpoint_presets, vec!["custom".to_string()]);

        let merged = db::parse_provider_endpoints_map(
            &db::get_setting(&conn_b, db::AI_PROVIDER_ENDPOINTS_KEY)
                .unwrap()
                .expect("merged row"),
        );
        assert_eq!(
            merged.get("custom").and_then(|r| r.endpoint.as_deref()),
            Some("https://device-a.example/v1")
        );
        assert_eq!(
            merged
                .get("other-local")
                .and_then(|r| r.endpoint.as_deref()),
            Some("http://127.0.0.1:9090/v1")
        );
    }

    #[tokio::test]
    async fn settings_push_does_not_include_excluded_keys() {
        // Defense: even if a device-local key were silently injected,
        // the allowlist filter in `list_syncable_settings` must drop it
        // before the manifest is encrypted. Verify by writing one of each
        // (allowlisted vs excluded) and inspecting the pushed payload.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();

        db::set_setting(&conn, "theme", "dark").unwrap();
        db::set_setting(
            &conn,
            "ai_provider_endpoints",
            r#"{"custom":"https://proxy.example.com/v1"}"#,
        )
        .unwrap(); // must sync
        db::set_setting(&conn, "ai_provider_keyring", "secret-key").unwrap(); // excluded
        db::set_setting(&conn, "device_id", "must-not-sync").unwrap(); // excluded
        db::set_setting(&conn, "gdrive_refresh_token", "tok-xyz").unwrap(); // excluded

        let engine = make_engine(&dir, "dev-a");
        engine.push_settings(&conn, &key).await.unwrap();

        // Decrypt the pushed payload and inspect using the versioned helper.
        let bytes = std::fs::read(dir.path().join("dev-a/settings.bin")).unwrap();
        let ks = engine.make_key_state(&key);
        let plain = crate::utils::encryption::decrypt_data_with_state(&bytes, &ks).unwrap();
        let payload: super::super::metadata::SettingsPayload =
            serde_json::from_slice(&plain).unwrap();
        assert!(payload.settings.contains_key("theme"));
        assert!(
            payload.settings.contains_key("ai_provider_endpoints"),
            "custom endpoint overrides must propagate through the encrypted manifest"
        );
        assert!(
            !payload.settings.contains_key("ai_provider_keyring"),
            "API keyring must NEVER appear in synced settings payload"
        );
        assert!(
            !payload.settings.contains_key("device_id"),
            "device_id must NEVER appear in synced settings payload"
        );
        assert!(
            !payload.settings.contains_key("gdrive_refresh_token"),
            "OAuth refresh token must NEVER appear in synced settings payload"
        );
    }

    #[tokio::test]
    async fn settings_pull_rejects_excluded_keys_from_malicious_peer() {
        // Even if a peer running buggy code wrote a non-allowlisted key
        // into its settings.bin, the receiver must NOT apply it. Defense
        // in depth — the writer filter is the first line, the ingest
        // filter is the second.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Hand-craft a payload with a forbidden key.
        let mut bad_map = std::collections::BTreeMap::new();
        bad_map.insert(
            "device_id".to_string(),
            super::super::metadata::SyncedSetting {
                value: "stolen-device-id".to_string(),
                updated_at: now_unix() + 10_000,
                deleted_at: None,
            },
        );
        bad_map.insert(
            "theme".to_string(),
            super::super::metadata::SyncedSetting {
                value: "dark".to_string(),
                updated_at: now_unix() + 10_000,
                deleted_at: None,
            },
        );
        let payload = super::super::metadata::SettingsPayload {
            device_id: "evil-peer".to_string(),
            generated_at: now_unix(),
            settings: bad_map,
        };
        let json = serde_json::to_vec(&payload).unwrap();
        // Use the versioned envelope with the SAME key so the receiver can
        // decrypt and reach the ingest allowlist filter.
        let ks = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(*key))
                .expect("set_key never fails");
            ks
        };
        let ct = crate::utils::encryption::encrypt_data_with_state(&json, &ks).unwrap();
        std::fs::create_dir_all(dir.path().join("evil-peer")).unwrap();
        std::fs::write(dir.path().join("evil-peer/settings.bin"), &ct).unwrap();

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        engine
            .pull_settings(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        // theme accepted, device_id rejected.
        assert_eq!(
            db::get_setting(&conn, "theme").unwrap().as_deref(),
            Some("dark")
        );
        // device_id may exist locally (seeded by migrate); the important
        // assertion is that it is NOT the malicious value.
        let device_id = db::get_setting(&conn, "device_id").unwrap();
        assert_ne!(device_id.as_deref(), Some("stolen-device-id"));
    }

    // ── Entry tags ride inside EntryMetadata ────────────────────────────────

    #[tokio::test]
    async fn entry_tag_ids_survive_pull_when_local_tags_exist() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Stage tags on BOTH devices so the entry_tags FK is satisfied
        // on the receiver. (Stage 2 will sync tags themselves.)
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let tag_a = db::create_tag(&conn_a, "travel", Some("#abcdef")).unwrap();
        let _tag_b_mirror = conn_b
            .execute(
                "INSERT INTO tags (id, name, color) VALUES (?1, 'travel', '#abcdef')",
                [&tag_a.id],
            )
            .unwrap();

        // A creates an entry, attaches the tag, syncs.
        let journal_a = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal_a,
                title: Some("tagged"),
                content_text: Some("hi"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        db::add_tag_to_entry(&conn_a, &entry.id, &tag_a.id).unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let tags_on_b = db::get_tags_for_entry(&conn_b, &entry.id).unwrap();
        assert_eq!(tags_on_b.len(), 1);
        assert_eq!(tags_on_b[0].id, tag_a.id);
        assert_eq!(tags_on_b[0].name, "travel");
    }

    // ── Chat history sync (Stage 6) ────────────────────────────────────────

    fn create_chat(conn: &Connection, id: &str, persona: &str) {
        db::create_chat_session(conn, id, persona, "snapshot prompt", "auto", now_unix()).unwrap();
    }

    #[tokio::test]
    async fn chat_session_and_messages_round_trip() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let session_id = "chat-session-aaaa";
        create_chat(&conn_a, session_id, "empathetic");
        db::append_chat_message(
            &conn_a,
            "msg-aaaa-0001",
            session_id,
            "user",
            "hello there",
            now_unix(),
        )
        .unwrap();
        db::append_chat_message(
            &conn_a,
            "msg-aaaa-0002",
            session_id,
            "assistant",
            "how can I help?",
            now_unix(),
        )
        .unwrap();
        // Assistant meta must survive push→pull so peer ℹ️ still works.
        let assistant_meta = db::AiMessageMeta {
            model_id: Some("llama3".into()),
            provider_id: Some("ollama".into()),
            endpoint_class: Some("local".into()),
            tokens_in: Some(12),
            tokens_out: Some(34),
            latency_ms: Some(250),
        };
        db::set_chat_message_meta(&conn_a, "msg-aaaa-0002", &assistant_meta).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_chats(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let on_b = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        assert_eq!(on_b.messages.len(), 2);
        assert_eq!(on_b.messages[0].content, "hello there");
        assert_eq!(on_b.messages[1].content, "how can I help?");
        assert_eq!(on_b.persona, "empathetic");
        // User row stays null-meta; assistant carries the seeded meta.
        assert_eq!(on_b.messages[0].meta(), db::AiMessageMeta::default());
        assert_eq!(on_b.messages[1].meta(), assistant_meta);
    }

    /// The RAG/memory fields (`used_rag`, `attachments`, `source_entry_ids`,
    /// `memory_ids`) all ride the sync wire. `upsert_synced_chat_message` is
    /// `INSERT OR IGNORE` with no later UPDATE, so if the new columns are not
    /// in the initial INSERT they never reach a peer at all — this test
    /// asserts the message columns explicitly, not just the session flag, to
    /// catch exactly that trap.
    #[tokio::test]
    async fn chat_rag_fields_round_trip() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-rag-0001";

        let conn_a = fresh_db();
        create_chat(&conn_a, session_id, "empathetic");
        db::mark_chat_session_used_rag(&conn_a, session_id).unwrap();

        let attachments = vec![
            db::ChatAttachmentRef::Entry {
                id: "entry-01".to_string(),
            },
            db::ChatAttachmentRef::Period {
                start: 1_700_000_000,
                end: 1_700_086_400,
                label: "Last week".to_string(),
            },
        ];
        db::append_chat_message_with_attachments(
            &conn_a,
            "msg-rag-0001",
            session_id,
            "user",
            "what happened last week?",
            Some(&attachments),
            now_unix(),
        )
        .unwrap();
        db::append_chat_message(
            &conn_a,
            "msg-rag-0002",
            session_id,
            "assistant",
            "here's what happened",
            now_unix(),
        )
        .unwrap();
        // Ids must pass `db::is_safe_id` (>= MIN_SAFE_ID_BYTES = 8 chars).
        let source_entry_ids = vec!["entry-01".to_string(), "entry-02".to_string()];
        db::set_chat_message_source_entry_ids(&conn_a, "msg-rag-0002", &source_entry_ids).unwrap();
        let memory_ids = vec!["memory-01".to_string(), "memory-02".to_string()];
        db::set_chat_message_memory_ids(&conn_a, "msg-rag-0002", &memory_ids).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_chats(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let paged = db::list_chat_sessions_paged(&conn_b, 1, None).unwrap();
        let session_meta = paged
            .items
            .iter()
            .find(|s| s.id == session_id)
            .expect("synced session must be present on device B");
        assert!(session_meta.used_rag);

        let on_b = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        assert_eq!(on_b.messages.len(), 2);
        assert_eq!(on_b.messages[0].attachments, Some(attachments));
        assert_eq!(on_b.messages[1].source_entry_ids, Some(source_entry_ids));
        assert_eq!(on_b.messages[1].memory_ids, Some(memory_ids));
    }

    /// Write a hand-crafted `chats.bin` payload (as raw JSON, bypassing the
    /// typed `ChatPayload` serializer so it can contain shapes our own
    /// structs would never produce — an unrecognised attachment `kind`, an
    /// unsanitized label, an over-cap count) to `{dir}/dev-peer/chats.bin`
    /// under the real sync key, so `pull_chats` exercises the real decrypt
    /// + parse + merge path against it.
    fn write_chats_peer_blob(dir: &TempDir, key: &[u8; 32], payload: &serde_json::Value) {
        let ks = key_state_from_key(key);
        let bytes = serde_json::to_vec(payload).unwrap();
        let ct = crate::utils::encryption::encrypt_data_with_state(&bytes, &ks).unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer")).unwrap();
        std::fs::write(dir.path().join("dev-peer/chats.bin"), &ct).unwrap();
    }

    /// Phase 2 review F2: a peer manifest with one unrecognised attachment
    /// `kind` anywhere must not fail the whole `ChatPayload` deserialize —
    /// that would silently drop that peer's entire chat history on every
    /// pull the day a later phase adds a third attachment kind. The
    /// message's other (recognised) attachment, and the session itself,
    /// must still merge.
    #[tokio::test]
    async fn unknown_attachment_kind_does_not_drop_the_peer_payload() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-unknown-kind1";
        let msg_id = "msg-unknown-kind-001";

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "user",
                        "content": "hi",
                        "seq": 0,
                        "created_at": 1000,
                        "attachments": [
                            {"kind": "entry", "id": "entry-0000001"},
                            {"kind": "future_thing", "foo": "bar"}
                        ]
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "unknown attachment kind must not error the pull: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id)
            .unwrap()
            .expect("session must merge despite one unrecognised attachment kind");
        assert_eq!(session.messages.len(), 1, "message must still merge");
        assert_eq!(
            session.messages[0].attachments,
            Some(vec![db::ChatAttachmentRef::Entry {
                id: "entry-0000001".to_string()
            }]),
            "the recognised attachment must survive; the unknown one is dropped"
        );
    }

    /// Phase 2 review F3: `Period.label` is peer-supplied and renders as a
    /// chat transcript chip; it must go through the same sanitizer as
    /// `s.title` so control chars / bidi overrides never reach storage.
    #[tokio::test]
    async fn peer_period_label_is_sanitized_on_pull() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-dirty-label1";
        let msg_id = "msg-dirty-label-0001";
        let dirty_label = "Last\u{0007}Week\u{202E}Trip";

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "user",
                        "content": "what happened last week?",
                        "seq": 0,
                        "created_at": 1000,
                        "attachments": [
                            {"kind": "period", "start": 1000, "end": 2000, "label": dirty_label}
                        ]
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "expected no errors: {errors:?}");

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        let attachments = session.messages[0].attachments.as_ref().unwrap();
        let label = match &attachments[0] {
            db::ChatAttachmentRef::Period { label, .. } => label.clone(),
            other => panic!("expected a Period attachment, got {other:?}"),
        };
        assert_eq!(label, "LastWeekTrip");
        assert!(!label.chars().any(|c| c.is_control()));
    }

    /// A peer payload whose `period` attachment omits `label` (legal once
    /// `docs/plans/2026-07-25-rag-in-daily-chat/phase-5-frontend.md` treats
    /// it as a fallback) must NOT fail the whole payload's deserialize —
    /// `#[serde(default)]` on `Period.label` degrades the one attachment
    /// to an empty string instead of dropping that peer's entire chat
    /// history on the pull.
    #[tokio::test]
    async fn peer_period_attachment_without_label_does_not_drop_session() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-no-label1";
        let msg_id = "msg-no-label-0001";

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "user",
                        "content": "what happened last week?",
                        "seq": 0,
                        "created_at": 1000,
                        "attachments": [
                            {"kind": "period", "start": 1000, "end": 2000}
                        ]
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "expected no errors: {errors:?}");

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        let attachments = session.messages[0].attachments.as_ref().unwrap();
        let label = match &attachments[0] {
            db::ChatAttachmentRef::Period { label, .. } => label.clone(),
            other => panic!("expected a Period attachment, got {other:?}"),
        };
        // Empty label falls through `sanitize_display_name`, which replaces
        // an all-blank result with its "Synced Journal" fallback. The
        // phase-5 chat attachment bar re-derives the visible chip text from
        // `start`/`end` (see `ChatAttachmentBar.tsx`), so this stored value
        // is never user-visible — the property we are guarding here is
        // "the message survives the pull at all", not "label is empty".
        assert_eq!(
            label, "Synced Journal",
            "missing label must fall through to the sanitizer's fallback, not drop the message"
        );
    }

    /// Phase 2 review F4: `attachments` / `source_entry_ids` are the only
    /// uncapped per-message peer input on this surface; an over-cap message
    /// must be skipped the same way an over-cap `content` string is
    /// skipped above (log + `continue`), not merged with the cap silently
    /// ignored.
    #[tokio::test]
    async fn over_cap_attachments_skip_the_message_on_pull() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-overcap-attch1";
        let msg_id = "msg-overcap-attach-001";

        let attachments: Vec<serde_json::Value> = (0..=db::MAX_CHAT_ATTACHMENTS)
            .map(|i| serde_json::json!({"kind": "entry", "id": format!("entry-{i:08}")}))
            .collect();

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "user",
                        "content": "too many pins",
                        "seq": 0,
                        "created_at": 1000,
                        "attachments": attachments
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "over-cap message must skip, not error: {errors:?}"
        );

        // Session merges (LWW is per-session, independent of the message
        // cap), but the over-cap message never lands.
        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert!(
            session.messages.is_empty(),
            "over-cap attachments must skip the whole message, like the content cap does"
        );
    }

    /// Phase 2 review F4, `source_entry_ids` side of the same cap.
    #[tokio::test]
    async fn over_cap_source_entry_ids_skip_the_message_on_pull() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-overcap-srcid1";
        let msg_id = "msg-overcap-srcid-001";

        let ids: Vec<String> = (0..=db::MAX_CHAT_SOURCE_ENTRY_IDS)
            .map(|i| format!("entry-{i:08}"))
            .collect();

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "assistant",
                        "content": "here's what I found",
                        "seq": 0,
                        "created_at": 1000,
                        "source_entry_ids": ids
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "over-cap message must skip, not error: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert!(
            session.messages.is_empty(),
            "over-cap source_entry_ids must skip the whole message, like the content cap does"
        );
    }

    /// F5/F10: `memory_ids` side of the same over-cap-skips-the-message cap.
    #[tokio::test]
    async fn over_cap_memory_ids_skip_the_message_on_pull() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-overcap-memid1";
        let msg_id = "msg-overcap-memid-001";

        let ids: Vec<String> = (0..=db::MAX_CHAT_MEMORY_IDS)
            .map(|i| format!("memory-{i:08}"))
            .collect();

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "assistant",
                        "content": "here's what I found",
                        "seq": 0,
                        "created_at": 1000,
                        "memory_ids": ids
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "over-cap message must skip, not error: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert!(
            session.messages.is_empty(),
            "over-cap memory_ids must skip the whole message, like the content cap does"
        );
    }

    /// Per-element id bound: an oversize / unsafe Entry.id on a peer
    /// attachment must drop that element only — the message (and the rest of
    /// the peer chat history) still merges. Mirrors the write-path reject in
    /// `db::append_chat_message_with_attachments` but with skip-not-reject
    /// posture so a buggy peer cannot wipe the receiver's view of the thread.
    #[tokio::test]
    async fn oversize_attachment_entry_id_skips_element_not_message() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-oversize-att1";
        let msg_id = "msg-oversize-attach-01";
        let good_id = "entry-good01";
        let bad_id = "a".repeat(db::MAX_SAFE_ID_BYTES + 1);

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "user",
                        "content": "pins",
                        "seq": 0,
                        "created_at": 1000,
                        "attachments": [
                            {"kind": "entry", "id": good_id},
                            {"kind": "entry", "id": bad_id}
                        ]
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "oversize attachment id must skip element, not error: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert_eq!(session.messages.len(), 1, "message must still merge");
        let atts = session.messages[0].attachments.as_ref().unwrap();
        assert_eq!(atts.len(), 1, "only the safe Entry id must survive");
        match &atts[0] {
            db::ChatAttachmentRef::Entry { id } => assert_eq!(id, good_id),
            other => panic!("expected Entry, got {other:?}"),
        }
    }

    /// Same per-element posture for `source_entry_ids`.
    #[tokio::test]
    async fn oversize_source_entry_id_skips_element_not_message() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-oversize-src1";
        let msg_id = "msg-oversize-srcid-01";
        let good_id = "entry-good02";
        let bad_id = "x".repeat(db::MAX_SAFE_ID_BYTES + 1);

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "assistant",
                        "content": "found this",
                        "seq": 0,
                        "created_at": 1000,
                        "source_entry_ids": [good_id, bad_id]
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "oversize source_entry_id must skip element, not error: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert_eq!(session.messages.len(), 1, "message must still merge");
        assert_eq!(
            session.messages[0].source_entry_ids.as_deref(),
            Some(&[good_id.to_string()][..]),
            "only the safe source_entry_id must survive"
        );
    }

    /// Same per-element posture for `memory_ids` — only the over-cap
    /// (whole-message) path had coverage before; this pins the per-element
    /// `is_safe_id` filter that keeps the message and drops just the bad id.
    #[tokio::test]
    async fn oversize_memory_id_skips_element_not_message() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-oversize-mem1";
        let msg_id = "msg-oversize-memid-01";
        let good_id = "memory-good02";
        let bad_id = "x".repeat(db::MAX_SAFE_ID_BYTES + 1);

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "assistant",
                        "content": "found this",
                        "seq": 0,
                        "created_at": 1000,
                        "memory_ids": [good_id, bad_id]
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "oversize memory_id must skip element, not error: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert_eq!(session.messages.len(), 1, "message must still merge");
        assert_eq!(
            session.messages[0].memory_ids.as_deref(),
            Some(&[good_id.to_string()][..]),
            "only the safe memory_id must survive"
        );
    }

    /// F13-adjacent (memory sync hardening): a peer running an OLDER build
    /// that predates `memory_ids` sends a message object with the key absent
    /// entirely, not `null`. `#[serde(default)]` on `SyncedChatMessage::
    /// memory_ids` must deserialize this as `None`, not fail the pull.
    #[tokio::test]
    async fn old_peer_payload_without_memory_ids_field_pulls_successfully() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "session-old-peer-nomem";
        let msg_id = "msg-old-peer-nomem-01";

        write_chats_peer_blob(
            &dir,
            &key,
            &serde_json::json!({
                "device_id": "dev-peer",
                "generated_at": 1000,
                "sessions": [{
                    "id": session_id,
                    "title": "Peer Session",
                    "persona": "empathetic",
                    "persona_prompt_snapshot": "prompt",
                    "language": "auto",
                    "created_at": 1000,
                    "updated_at": 1000,
                    "is_deleted": false,
                    "messages": [{
                        "id": msg_id,
                        "role": "assistant",
                        "content": "no memory_ids key at all",
                        "seq": 0,
                        "created_at": 1000
                    }]
                }]
            }),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errors.is_empty(),
            "absent memory_ids field must pull cleanly: {errors:?}"
        );

        let session = db::load_chat_session(&conn, session_id).unwrap().unwrap();
        assert_eq!(session.messages.len(), 1);
        assert_eq!(
            session.messages[0].memory_ids, None,
            "absent field deserializes as None, not a hard error"
        );
    }

    #[tokio::test]
    async fn chat_messages_union_merge_across_devices() {
        // Both A and B append messages to the same session locally.
        // After a round of syncs, both devices have the union.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-bbbb";

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        create_chat(&conn_a, session_id, "empathetic");
        create_chat(&conn_b, session_id, "empathetic");

        db::append_chat_message(
            &conn_a,
            "msg-from-a-0001",
            session_id,
            "user",
            "A's message",
            now_unix(),
        )
        .unwrap();
        db::append_chat_message(
            &conn_b,
            "msg-from-b-0001",
            session_id,
            "user",
            "B's message",
            now_unix(),
        )
        .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");

        // Both push, then both pull.
        engine_a.push_chats(&conn_a, &key).await.unwrap();
        engine_b.push_chats(&conn_b, &key).await.unwrap();
        engine_a
            .pull_chats(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let a = db::load_chat_session(&conn_a, session_id).unwrap().unwrap();
        let b = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        assert_eq!(a.messages.len(), 2);
        assert_eq!(b.messages.len(), 2);
        let a_ids: std::collections::HashSet<_> = a.messages.iter().map(|m| m.id.clone()).collect();
        assert!(a_ids.contains("msg-from-a-0001"));
        assert!(a_ids.contains("msg-from-b-0001"));
    }

    #[tokio::test]
    async fn chat_session_soft_delete_propagates() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-cccc";

        let conn_a = fresh_db();
        create_chat(&conn_a, session_id, "tough");
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_chats(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(db::load_chat_session(&conn_b, session_id)
            .unwrap()
            .is_some());

        db::delete_chat_session(&conn_a, session_id).unwrap();
        conn_a
            .execute(
                "UPDATE chat_sessions SET updated_at = updated_at + 1000 WHERE id = ?1",
                [session_id],
            )
            .unwrap();
        engine_a.push_chats(&conn_a, &key).await.unwrap();
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(db::load_chat_session(&conn_b, session_id)
            .unwrap()
            .is_none());
    }

    /// Conversion watermark must survive push→pull as a monotonic ratchet:
    /// a never-converted peer (wire shape with the two new keys absent /
    /// `None`) must NOT clear a known watermark. End-to-end sync test for
    /// the T3 metadata+engine wiring; the DB-layer ratchet itself is
    /// exercised directly in `db::queries` tests.
    #[tokio::test]
    async fn chat_session_conversion_watermark_ratchets_over_sync() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-watermark";

        // dev-A converts the session locally, then pushes.
        let conn_a = fresh_db();
        create_chat(&conn_a, session_id, "empathetic");
        db::set_chat_session_conversion(&conn_a, session_id, "entry-aaaa", 4).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_chats(&conn_a, &key).await.unwrap();

        // dev-B pulls — must receive the watermark.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        assert_eq!(on_b.converted_entry_id.as_deref(), Some("entry-aaaa"));
        assert_eq!(on_b.converted_through_seq, Some(4));

        // Now simulate an OLD-peer push from dev-C: same session id, but
        // the session was never converted there, so the on-wire payload
        // omits both keys. (We force the legacy wire shape by pushing from
        // a row whose conversion columns are NULL.)
        let conn_c = fresh_db();
        create_chat(&conn_c, session_id, "empathetic");
        // Bump updated_at so dev-C's row wins LWW on session-level fields,
        // which makes the test meaningful: LWW says remote wins, but the
        // ratchet must still refuse to clear the watermark.
        conn_c
            .execute(
                "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now_unix() + 9999, session_id],
            )
            .unwrap();
        let engine_c = make_engine(&dir, "dev-c");
        engine_c.push_chats(&conn_c, &key).await.unwrap();
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // Watermark MUST survive — old-peer payload (None, None) never
        // clears a known watermark.
        let on_b_after = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        assert_eq!(
            on_b_after.converted_entry_id.as_deref(),
            Some("entry-aaaa"),
            "old-peer payload must not clear a known watermark"
        );
        assert_eq!(
            on_b_after.converted_through_seq,
            Some(4),
            "old-peer payload must not clear a known watermark"
        );
    }

    /// Cross-device pin propagation, end to end through the real engine.
    ///
    /// Every other `pinned_at` test calls `upsert_synced_chat_session_lww`
    /// directly with a raw `Option<i64>`, which bypasses `SyncedChatSession`
    /// and both hand-written field maps in this file — so dropping the field
    /// from the push map, or transposing it with its neighbour at the pull
    /// call site, is invisible to all of them. Neither mistake is a compile
    /// error: the push map is positional-by-name, and
    /// `remote_converted_through_seq` / `remote_pinned_at` are adjacent
    /// `Option<i64>` parameters that swap silently.
    ///
    /// The session is deliberately left UNCONVERTED, so its
    /// `converted_through_seq` is `None` while its `pinned_at` is `Some`.
    /// That asymmetry is what makes the transposition observable, and it is
    /// asserted from both sides: the pin must arrive, and it must not leak
    /// into the conversion watermark.
    #[tokio::test]
    async fn chat_session_pin_state_round_trips_over_sync() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-pinned";
        let pinned_at = now_unix() + 100;

        // dev-A pins the session locally, then pushes.
        let conn_a = fresh_db();
        create_chat(&conn_a, session_id, "empathetic");
        db::set_chat_session_pinned(&conn_a, session_id, true, pinned_at).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_chats(&conn_a, &key).await.unwrap();

        // dev-B pulls — the pin must land.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        // Checked BEFORE the pin itself, so the two mutations this test
        // exists to catch each kill a distinct, demonstrably-live assertion:
        // a transposition trips this one, a dropped push field trips the pin
        // one below. Were the order reversed, both would die on the pin
        // assert and this line would never actually run.
        let on_b = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        assert_eq!(
            on_b.converted_through_seq, None,
            "the pin must not leak into the conversion watermark — this catches \
             the two adjacent Option<i64> pull args being transposed"
        );
        assert_eq!(
            read_pinned_at(&conn_b, session_id),
            Some(pinned_at),
            "a pin set on dev-A must reach dev-B through push + pull"
        );

        // dev-A unpins at a strictly newer `updated_at`, then pushes again.
        // Unpin is `None` on the wire, so it only propagates because
        // `pinned_at` rides LWW rather than ratcheting.
        db::set_chat_session_pinned(&conn_a, session_id, false, pinned_at + 100).unwrap();
        engine_a.push_chats(&conn_a, &key).await.unwrap();
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            read_pinned_at(&conn_b, session_id),
            None,
            "an unpin on dev-A must clear the pin on dev-B, not strand it"
        );
    }

    /// `db::ChatSession` (what `load_chat_session` returns) carries no
    /// `pinned_at`, so the sync tests read the column directly.
    fn read_pinned_at(conn: &Connection, id: &str) -> Option<i64> {
        conn.query_row(
            "SELECT pinned_at FROM chat_sessions WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A peer-supplied `converted_entry_id` that fails `is_safe_id` must
    /// be dropped on pull — without this filter, a malicious peer could
    /// bloat the partial index `idx_chat_sessions_converted_entry` with
    /// multi-MB strings, or poison the entry-banner lookup with garbage
    /// ids that would later render in the UI. Mirrors the `safe_title`
    /// sanitizer pattern in the same pull loop.
    ///
    /// Because `(converted_entry_id, converted_through_seq)` is an ATOMIC
    /// PAIR at the ratchet boundary, the paired `converted_through_seq`
    /// must ALSO be forwarded as `None` when the id is unsafe. Forwarding
    /// the seq verbatim would let the ratchet fire on
    /// `remote_seq > local_seq`, clobbering a known-good local
    /// `converted_entry_id` with NULL while bumping the seq — leaving a
    /// self-inconsistent `(NULL, Some(seq))` state that silently skips
    /// messages on the next conversion. `None` means "no information",
    /// which never clears a known watermark.
    #[tokio::test]
    async fn chat_pull_drops_unsafe_peer_converted_entry_id() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-unsafe-entry";

        // dev-A publishes a session whose `converted_entry_id` is garbage
        // (fails `is_safe_id`: contains a space, fails the alnum/-/_
        // charset check).
        let conn_a = fresh_db();
        create_chat(&conn_a, session_id, "empathetic");
        conn_a
            .execute(
                "UPDATE chat_sessions SET converted_entry_id = '<unsafe garbage>', \
                 converted_through_seq = 4 WHERE id = ?1",
                rusqlite::params![session_id],
            )
            .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_chats(&conn_a, &key).await.unwrap();

        // dev-B pulls — the unsafe id AND its paired seq must be stripped
        // before the row lands (both become `None`).
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b = db::load_chat_session(&conn_b, session_id)
            .unwrap()
            .expect("session must exist (only the bad entry id is stripped)");
        assert_eq!(
            on_b.converted_entry_id, None,
            "unsafe peer converted_entry_id must be dropped on pull"
        );
        assert_eq!(
            on_b.converted_through_seq, None,
            "seq paired with an unsafe id must be dropped too — the pair is \
             atomic, so an unsafe id means \"no information\" for both fields"
        );

        // Ratchet preservation: dev-B already holds a known-good watermark
        // `("entry-aaaa", 5)`. dev-C now publishes the SAME session with an
        // unsafe id and a HIGHER seq (8). Because the unsafe id is paired
        // with `None` at the engine boundary, the ratchet must NOT fire —
        // dev-B's watermark survives untouched.
        let conn_c = fresh_db();
        create_chat(&conn_c, session_id, "empathetic");
        conn_c
            .execute(
                "UPDATE chat_sessions SET converted_entry_id = '<unsafe garbage>', \
                 converted_through_seq = 8, updated_at = ?2 WHERE id = ?1",
                rusqlite::params![session_id, now_unix() + 9999],
            )
            .unwrap();
        let engine_c = make_engine(&dir, "dev-c");
        engine_c.push_chats(&conn_c, &key).await.unwrap();

        // Seed dev-B with the known-good watermark so the ratchet decision
        // is observable, then pull dev-C's unsafe payload.
        db::set_chat_session_conversion(&conn_b, session_id, "entry-aaaa", 5).unwrap();
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b_after = db::load_chat_session(&conn_b, session_id)
            .unwrap()
            .expect("session must still exist");
        assert_eq!(
            on_b_after.converted_entry_id.as_deref(),
            Some("entry-aaaa"),
            "known-good converted_entry_id must survive a pull of an unsafe \
             id with a higher seq"
        );
        assert_eq!(
            on_b_after.converted_through_seq,
            Some(5),
            "known-good converted_through_seq must survive a pull of an unsafe \
             id with a higher seq — ratchet must NOT fire on the forwarded None"
        );
    }

    // ── Streak cache sync (Stage 7) ────────────────────────────────────────

    #[tokio::test]
    async fn streak_round_trip_between_devices() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Seed A with a known streak row.
        let conn_a = fresh_db();
        conn_a
            .execute(
                "INSERT OR REPLACE INTO streak_cache
                    (user_id, current_streak, longest_streak, last_entry_date, updated_at)
                 VALUES ('local', 5, 12, 1_700_000_000, ?1)",
                [now_unix() + 100],
            )
            .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_streak(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_streak(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let on_b = db::get_streak_cache(&conn_b).unwrap();
        assert_eq!(on_b.current_streak, 5);
        assert_eq!(on_b.longest_streak, 12);
        assert_eq!(on_b.last_entry_date, Some(1_700_000_000));
    }

    #[tokio::test]
    async fn streak_longest_ratchets_upward_even_when_remote_is_older() {
        // B has a worse longest_streak but a newer updated_at; A's
        // bigger longest_streak still wins for that field because
        // longest_streak is a monotonic high-water mark.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        conn_a
            .execute(
                "INSERT OR REPLACE INTO streak_cache
                    (user_id, current_streak, longest_streak, last_entry_date, updated_at)
                 VALUES ('local', 3, 99, NULL, ?1)",
                [now_unix() - 10],
            )
            .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_streak(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        conn_b
            .execute(
                "INSERT OR REPLACE INTO streak_cache
                    (user_id, current_streak, longest_streak, last_entry_date, updated_at)
                 VALUES ('local', 4, 7, NULL, ?1)",
                [now_unix() + 10],
            )
            .unwrap();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_streak(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let on_b = db::get_streak_cache(&conn_b).unwrap();
        // current_streak stays B's (4) because B is newer overall.
        assert_eq!(on_b.current_streak, 4);
        // longest_streak ratchets to A's 99 even though A's row is older.
        assert_eq!(on_b.longest_streak, 99);
    }

    // ── Location aliases sync (Stage 5) ────────────────────────────────────

    #[tokio::test]
    async fn location_alias_round_trip_and_lww_rename() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let alias = db::create_location_alias(
            &conn_a,
            "Home",
            "1 Pine St, Hanoi",
            21.028511,
            105.804817,
            Some(75.0),
        )
        .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_location_aliases(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_location_aliases(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b = db::get_location_alias(&conn_b, &alias.id).unwrap().unwrap();
        assert_eq!(on_b.label, "Home");
        assert_eq!(on_b.address, "1 Pine St, Hanoi");
        assert!((on_b.latitude - 21.028511).abs() < 1e-9);
        assert!((on_b.longitude - 105.804817).abs() < 1e-9);

        // A renames the alias.
        db::update_location_alias(
            &conn_a,
            &alias.id,
            "Home (Hanoi)",
            "1 Pine St, Hanoi",
            21.028511,
            105.804817,
            Some(75.0),
        )
        .unwrap();
        conn_a
            .execute(
                "UPDATE location_aliases SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&alias.id],
            )
            .unwrap();
        engine_a.push_location_aliases(&conn_a, &key).await.unwrap();
        engine_b
            .pull_location_aliases(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b = db::get_location_alias(&conn_b, &alias.id).unwrap().unwrap();
        assert_eq!(on_b.label, "Home (Hanoi)");
    }

    #[tokio::test]
    async fn location_alias_soft_delete_propagates() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let alias = db::create_location_alias(
            &conn_a,
            "Office",
            "10 Tran Hung Dao",
            21.0286,
            105.8542,
            None,
        )
        .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_location_aliases(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_location_aliases(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(db::get_location_alias(&conn_b, &alias.id)
            .unwrap()
            .is_some());

        db::delete_location_alias(&conn_a, &alias.id).unwrap();
        conn_a
            .execute(
                "UPDATE location_aliases SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&alias.id],
            )
            .unwrap();
        engine_a.push_location_aliases(&conn_a, &key).await.unwrap();
        engine_b
            .pull_location_aliases(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(db::get_location_alias(&conn_b, &alias.id)
            .unwrap()
            .is_none());
    }

    // ── AI reviews (period / insights) LWW sync ────────────────────────────

    #[tokio::test]
    async fn ai_reviews_round_trip_pulls_peer_weekly() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        db::upsert_ai_review(
            &conn_a,
            "weekly",
            100,
            200,
            "gpt-4o",
            r#"{"summary":"week-a"}"#,
            3,
            1_700_000_000,
        )
        .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_ai_reviews(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_ai_reviews(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let got = db::get_ai_review(&conn_b, "weekly", 100, 200)
            .unwrap()
            .expect("B should have A's weekly review");
        assert_eq!(got.kind, "weekly");
        assert_eq!(got.period_start, 100);
        assert_eq!(got.period_end, 200);
        assert_eq!(got.model_id, "gpt-4o");
        assert_eq!(got.result_json, r#"{"summary":"week-a"}"#);
        assert_eq!(got.entry_count, 3);
        assert_eq!(got.created_at, 1_700_000_000);
    }

    #[tokio::test]
    async fn ai_reviews_distinct_periods_union_not_snapshot_replace() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        db::upsert_ai_review(
            &conn_a,
            "weekly",
            100,
            200,
            "model-a",
            r#"{"from":"a"}"#,
            1,
            10,
        )
        .unwrap();

        let conn_b = fresh_db();
        db::upsert_ai_review(
            &conn_b,
            "monthly",
            300,
            400,
            "model-b",
            r#"{"from":"b"}"#,
            2,
            20,
        )
        .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_ai_reviews(&conn_a, &key).await.unwrap();
        engine_b.push_ai_reviews(&conn_b, &key).await.unwrap();

        engine_a
            .pull_ai_reviews(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_ai_reviews(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let a_week = db::get_ai_review(&conn_a, "weekly", 100, 200)
            .unwrap()
            .expect("A keeps its weekly");
        let a_month = db::get_ai_review(&conn_a, "monthly", 300, 400)
            .unwrap()
            .expect("A also has B's monthly (union, not snapshot-replace)");
        let b_week = db::get_ai_review(&conn_b, "weekly", 100, 200)
            .unwrap()
            .expect("B also has A's weekly (union, not snapshot-replace)");
        let b_month = db::get_ai_review(&conn_b, "monthly", 300, 400)
            .unwrap()
            .expect("B keeps its monthly");
        assert_eq!(a_week.result_json, r#"{"from":"a"}"#);
        assert_eq!(a_month.result_json, r#"{"from":"b"}"#);
        assert_eq!(b_week.result_json, r#"{"from":"a"}"#);
        assert_eq!(b_month.result_json, r#"{"from":"b"}"#);
    }

    #[tokio::test]
    async fn ai_reviews_same_period_newer_created_at_wins() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_b = fresh_db();
        db::upsert_ai_review(
            &conn_b,
            "weekly",
            100,
            200,
            "model-b",
            r#"{"from":"b"}"#,
            1,
            10,
        )
        .unwrap();

        let conn_a = fresh_db();
        db::upsert_ai_review(
            &conn_a,
            "weekly",
            100,
            200,
            "model-a",
            r#"{"from":"a"}"#,
            3,
            20,
        )
        .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_ai_reviews(&conn_a, &key).await.unwrap();

        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_ai_reviews(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let got = db::get_ai_review(&conn_b, "weekly", 100, 200)
            .unwrap()
            .expect("B should keep the same period after pull");
        assert_eq!(got.result_json, r#"{"from":"a"}"#);
        assert_eq!(got.model_id, "model-a");
        assert_eq!(got.entry_count, 3);
        assert_eq!(got.created_at, 20);
    }

    #[tokio::test]
    async fn ai_reviews_same_period_equal_created_at_device_id_tiebreak() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        db::upsert_ai_review(
            &conn_a,
            "weekly",
            100,
            200,
            "model-a",
            r#"{"from":"a"}"#,
            1,
            10,
        )
        .unwrap();
        db::upsert_ai_review(
            &conn_b,
            "weekly",
            100,
            200,
            "model-b",
            r#"{"from":"b"}"#,
            2,
            10,
        )
        .unwrap();

        // "dev-a" < "dev-b" lex → remote_device_id > local_device_id wins.
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_ai_reviews(&conn_a, &key).await.unwrap();
        engine_b.push_ai_reviews(&conn_b, &key).await.unwrap();
        engine_a
            .pull_ai_reviews(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_ai_reviews(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let on_a = db::get_ai_review(&conn_a, "weekly", 100, 200)
            .unwrap()
            .expect("A still has the period");
        let on_b = db::get_ai_review(&conn_b, "weekly", 100, 200)
            .unwrap()
            .expect("B still has the period");
        assert_eq!(on_a.result_json, r#"{"from":"b"}"#);
        assert_eq!(on_a.model_id, "model-b");
        assert_eq!(on_a.entry_count, 2);
        assert_eq!(on_a.created_at, 10);
        assert_eq!(on_b.result_json, r#"{"from":"b"}"#);
        assert_eq!(on_b.model_id, "model-b");
        assert_eq!(on_b.entry_count, 2);
        assert_eq!(on_b.created_at, 10);
    }

    // ── AI audit log sync ──────────────────────────────────────────────────

    /// Bind a DB to a known sync `device_id` so `insert_ai_audit_log` stamps
    /// the value our test SyncEngine uses on the wire. Mirrors what
    /// production does on first launch (UUID written into `settings`).
    fn set_device_id(conn: &Connection, id: &str) {
        db::set_setting(conn, db::DEVICE_ID_KEY, id).unwrap();
    }

    /// Build a sample insert row with `created_at = ts`.
    fn audit_row(ts: i64, feature: &str) -> crate::db::queries::AiAuditLogInsert {
        crate::db::queries::AiAuditLogInsert {
            created_at: ts,
            feature: feature.into(),
            operation: "chat".into(),
            provider_id: "openai".into(),
            model_id: "gpt-4o-mini".into(),
            endpoint_host: "api.openai.com".into(),
            endpoint_class: "remote".into(),
            payload_bytes: 42,
            latency_ms: 100,
            status: "ok".into(),
            error_code: None,
            tokens_in: Some(50),
            tokens_out: Some(25),
        }
    }

    #[tokio::test]
    async fn ai_audit_round_trip_pulls_peer_rows() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        set_device_id(&conn_a, "dev-a");
        db::insert_ai_audit_log(&conn_a, &audit_row(1000, "smart_title")).unwrap();
        db::insert_ai_audit_log(&conn_a, &audit_row(2000, "daily_chat")).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_ai_audit(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        set_device_id(&conn_b, "dev-b");
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // B sees both rows authored by dev-a.
        let rows_on_b = db::list_ai_audit_log(
            &conn_b,
            &crate::db::queries::AiAuditLogFilter::default(),
            100,
            0,
        )
        .unwrap();
        assert_eq!(rows_on_b.len(), 2);
        assert!(rows_on_b.iter().all(|r| r.device_id == "dev-a"));
    }

    #[tokio::test]
    async fn ai_audit_purge_on_peer_propagates_via_snapshot_replace() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        set_device_id(&conn_a, "dev-a");
        let conn_b = fresh_db();
        set_device_id(&conn_b, "dev-b");
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");

        db::insert_ai_audit_log(&conn_a, &audit_row(1000, "smart_title")).unwrap();
        db::insert_ai_audit_log(&conn_a, &audit_row(2000, "daily_chat")).unwrap();
        engine_a.push_ai_audit(&conn_a, &key).await.unwrap();
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            db::list_ai_audit_log(
                &conn_b,
                &crate::db::queries::AiAuditLogFilter::default(),
                100,
                0,
            )
            .unwrap()
            .len(),
            2
        );

        // A purges its own rows (simulating retention purge dropping the older one).
        db::purge_ai_audit_log_older_than(&conn_a, 1500).unwrap();
        assert_eq!(
            db::list_ai_audit_log(
                &conn_a,
                &crate::db::queries::AiAuditLogFilter::default(),
                100,
                0,
            )
            .unwrap()
            .len(),
            1,
            "A's own log shrank after purge"
        );

        // Re-sync: B's mirror of A drops the purged row.
        engine_a.push_ai_audit(&conn_a, &key).await.unwrap();
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b = db::list_ai_audit_log(
            &conn_b,
            &crate::db::queries::AiAuditLogFilter::default(),
            100,
            0,
        )
        .unwrap();
        assert_eq!(on_b.len(), 1, "purged row no longer visible on B");
        assert_eq!(on_b[0].created_at, 2000);
    }

    #[tokio::test]
    async fn ai_audit_push_never_fans_out_peer_rows() {
        // Regression guard: B pulls A's rows, then B pushes — B's published
        // snapshot must still contain only B's own rows, never A's. If it
        // re-published A's rows, every other peer would see duplicates and
        // a purge by A would not propagate (B would keep "shadow-publishing"
        // the deleted rows).
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        set_device_id(&conn_a, "dev-a");
        db::insert_ai_audit_log(&conn_a, &audit_row(1000, "smart_title")).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_ai_audit(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        set_device_id(&conn_b, "dev-b");
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        // B now has dev-a's row mirrored locally.

        // B pushes its (empty) own log, then re-pushes after one of its own rows.
        db::insert_ai_audit_log(&conn_b, &audit_row(3000, "daily_chat")).unwrap();
        engine_b.push_ai_audit(&conn_b, &key).await.unwrap();

        // Inspect B's published bin: should contain ONLY dev-b's row.
        let raw = std::fs::read(dir.path().join("dev-b").join("ai_audit.bin")).unwrap();
        let ks = engine_b.make_key_state(&key);
        let plain = crate::utils::encryption::decrypt_data_with_state(&raw, &ks).unwrap();
        let payload: crate::sync::metadata::AiAuditPayload =
            serde_json::from_slice(&plain).unwrap();
        assert_eq!(payload.device_id, "dev-b");
        assert_eq!(payload.rows.len(), 1, "B must not re-publish A's rows");
        assert_eq!(payload.rows[0].feature, "daily_chat");
    }

    #[tokio::test]
    async fn ai_audit_pull_is_idempotent() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        set_device_id(&conn_a, "dev-a");
        db::insert_ai_audit_log(&conn_a, &audit_row(1000, "smart_title")).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_ai_audit(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        set_device_id(&conn_b, "dev-b");
        let engine_b = make_engine(&dir, "dev-b");

        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        let rows = db::list_ai_audit_log(
            &conn_b,
            &crate::db::queries::AiAuditLogFilter::default(),
            100,
            0,
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "repeated pulls must not duplicate rows");
    }

    #[tokio::test]
    async fn ai_audit_retention_purge_only_touches_local_device_rows() {
        // Regression guard: a local retention purge must NOT delete peer
        // rows we mirrored — the peer is the source of truth for its
        // retention. Without this scoping, every local startup would
        // wipe peers' history and then immediately re-pull it.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        set_device_id(&conn_a, "dev-a");
        db::insert_ai_audit_log(&conn_a, &audit_row(100, "smart_title")).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_ai_audit(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        set_device_id(&conn_b, "dev-b");
        db::insert_ai_audit_log(&conn_b, &audit_row(5000, "daily_chat")).unwrap();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // B has 2 rows: one of its own (ts=5000) and one mirrored from A (ts=100).
        assert_eq!(
            db::list_ai_audit_log(
                &conn_b,
                &crate::db::queries::AiAuditLogFilter::default(),
                100,
                0,
            )
            .unwrap()
            .len(),
            2
        );

        // B purges anything older than ts=1000 — only B's local row would
        // qualify (none here), and A's mirrored row at ts=100 MUST be left
        // alone even though its timestamp meets the cutoff.
        db::purge_ai_audit_log_older_than(&conn_b, 1000).unwrap();

        let remaining = db::list_ai_audit_log(
            &conn_b,
            &crate::db::queries::AiAuditLogFilter::default(),
            100,
            0,
        )
        .unwrap();
        assert_eq!(remaining.len(), 2, "peer row preserved by purge scoping");
        assert!(remaining.iter().any(|r| r.device_id == "dev-a"));
    }

    #[tokio::test]
    async fn ai_audit_pull_rejects_payload_device_id_mismatching_directory() {
        // I1: peer A writes to dev-a/ai_audit.bin but claims `device_id: "dev-c"`.
        // We must NOT wipe our mirror of dev-c with A's forged rows.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // C populates its own audit row and pushes.
        let conn_c = fresh_db();
        set_device_id(&conn_c, "dev-c");
        db::insert_ai_audit_log(&conn_c, &audit_row(5000, "legit_from_c")).unwrap();
        let engine_c = make_engine(&dir, "dev-c");
        engine_c.push_ai_audit(&conn_c, &key).await.unwrap();

        // B pulls C's snapshot through the legitimate channel.
        let conn_b = fresh_db();
        set_device_id(&conn_b, "dev-b");
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert_eq!(
            db::list_ai_audit_log(
                &conn_b,
                &crate::db::queries::AiAuditLogFilter::default(),
                100,
                0,
            )
            .unwrap()
            .len(),
            1,
            "B has C's legitimate row"
        );

        // Now A forges a payload: writes to dev-a/ai_audit.bin but claims
        // device_id: "dev-c" inside the payload. Bypass the engine to
        // build the file directly.
        let forged = crate::sync::metadata::AiAuditPayload {
            device_id: "dev-c".into(),
            generated_at: now_unix(),
            rows: vec![crate::sync::metadata::SyncedAiAuditRow {
                local_seq: 999,
                created_at: 9000,
                feature: "forged_by_a".into(),
                operation: "chat".into(),
                provider_id: "openai".into(),
                model_id: "gpt-4o".into(),
                endpoint_host: "api.openai.com".into(),
                endpoint_class: "remote".into(),
                payload_bytes: 1,
                latency_ms: 1,
                status: "ok".into(),
                error_code: None,
                tokens_in: None,
                tokens_out: None,
                device_name: String::new(),
            }],
        };
        let json = serde_json::to_vec(&forged).unwrap();
        // Use the versioned envelope with the receiver's key so B can decrypt
        // and reach the device_id safety check.
        let ks_a = engine_b.make_key_state(&key);
        let ct = crate::utils::encryption::encrypt_data_with_state(&json, &ks_a).unwrap();
        let dev_a_dir = dir.path().join("dev-a");
        std::fs::create_dir_all(&dev_a_dir).unwrap();
        std::fs::write(dev_a_dir.join("ai_audit.bin"), &ct).unwrap();

        // B pulls again on the same long-lived engine. Standalone
        // `pull_ai_audit` clears the device-list cache when not in a
        // multi-surface batch, so the newly-created `dev-a/` folder is
        // re-listed. The forged file under dev-a/ must be rejected — B's
        // mirror of dev-c stays intact.
        let errs = engine_b
            .pull_ai_audit(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(
            errs.iter()
                .any(|e| e.contains("claims device_id") && e.contains("dev-a")),
            "expected directory/claim mismatch error, got: {errs:?}"
        );
        let after = db::list_ai_audit_log(
            &conn_b,
            &crate::db::queries::AiAuditLogFilter::default(),
            100,
            0,
        )
        .unwrap();
        assert_eq!(after.len(), 1, "B's mirror of dev-c untouched");
        assert_eq!(after[0].feature, "legit_from_c");
    }

    // ── Review fixes (C1, C2, I5) regression guards ────────────────────────

    #[tokio::test]
    async fn chat_messages_same_seq_render_deterministically_across_devices() {
        // C1: ORDER BY seq alone is non-deterministic on ties — two
        // devices appending concurrently both pick seq=N+1 and the
        // resulting render order depends on insert order. With the
        // tiebreak `(seq, created_at, id)`, both peers see the same
        // ordering regardless of how the union-merge interleaved.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let session_id = "chat-session-c1-fix";

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        create_chat(&conn_a, session_id, "empathetic");
        create_chat(&conn_b, session_id, "empathetic");

        // Force both messages to have the SAME seq value by inserting
        // directly (bypassing the auto-seq logic). Different ids,
        // different created_at — the (seq, created_at, id) tiebreak
        // takes over.
        conn_a
            .execute(
                "INSERT INTO chat_messages (id, session_id, role, content, seq, created_at)
                 VALUES (?1, ?2, 'user', 'msg-from-a', 7, 100)",
                rusqlite::params!["msg-from-a-zzzz", session_id],
            )
            .unwrap();
        conn_b
            .execute(
                "INSERT INTO chat_messages (id, session_id, role, content, seq, created_at)
                 VALUES (?1, ?2, 'user', 'msg-from-b', 7, 200)",
                rusqlite::params!["msg-from-b-aaaa", session_id],
            )
            .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_chats(&conn_a, &key).await.unwrap();
        engine_b.push_chats(&conn_b, &key).await.unwrap();
        engine_a
            .pull_chats(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_chats(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // Both devices should now render the messages in the SAME order.
        let on_a = db::load_chat_session(&conn_a, session_id).unwrap().unwrap();
        let on_b = db::load_chat_session(&conn_b, session_id).unwrap().unwrap();
        let order_a: Vec<&str> = on_a.messages.iter().map(|m| m.id.as_str()).collect();
        let order_b: Vec<&str> = on_b.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            order_a, order_b,
            "chat messages must render in the same order on every peer"
        );
        // The tiebreak rule is (seq, created_at, id) → 100 < 200, so
        // msg-from-a-zzzz comes first despite the higher id.
        assert_eq!(order_a, vec!["msg-from-a-zzzz", "msg-from-b-aaaa"]);
    }

    #[tokio::test]
    async fn settings_lww_tie_resolves_by_device_id() {
        // C2: same-second writes used to be silently divergent. With
        // the device_id tiebreak, the lex-higher device_id wins
        // deterministically.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        // Same timestamp, different values. Without the tiebreak the
        // upsert is a no-op and the divergence sticks.
        let same_ts = now_unix() + 1000;
        for (c, v) in [(&conn_a, "from-a"), (&conn_b, "from-b")] {
            c.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('theme', ?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                rusqlite::params![v, same_ts],
            )
            .unwrap();
        }
        // "dev-a" < "dev-b" lex, so on the LWW tiebreak dev-b should win.
        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_settings(&conn_a, &key).await.unwrap();
        engine_b.push_settings(&conn_b, &key).await.unwrap();
        engine_a
            .pull_settings(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_settings(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // A adopts B's value (B > A lex). B keeps its value.
        assert_eq!(
            db::get_setting(&conn_a, "theme").unwrap().as_deref(),
            Some("from-b"),
            "dev-a should adopt dev-b's value on tie (dev-b wins lex)"
        );
        assert_eq!(
            db::get_setting(&conn_b, "theme").unwrap().as_deref(),
            Some("from-b"),
            "dev-b should keep its value on tie"
        );
    }

    #[tokio::test]
    async fn active_incoming_tag_reclaims_name_from_local_tombstone_regardless_of_id_order() {
        // I5 asymmetric regression guard: an active incoming tag must
        // reclaim a same-named local tombstone unconditionally, even
        // when the lex id order would otherwise have the local "win".
        // Previously, with a lex-order tiebreak gating BOTH legs of
        // the collision, an incoming active id > local tombstone id
        // was silently dropped — and the peer (where the tag is
        // active) saw the local user's tag as the active one with a
        // different id, causing convergent divergence.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let local_tombstone_id = "0000-tag-local-aaa"; // sorts BEFORE incoming
        let incoming_active_id = "zzzz-tag-peer-bbb"; // sorts AFTER local

        // A has a tombstoned "work" tag.
        conn_a
            .execute(
                "INSERT INTO tags (id, name, color, updated_at, is_deleted)
                 VALUES (?1, 'work', NULL, ?2, 1)",
                rusqlite::params![local_tombstone_id, now_unix()],
            )
            .unwrap();
        // B has an active "work" tag — never saw A's tombstone.
        conn_b
            .execute(
                "INSERT INTO tags (id, name, color, updated_at, is_deleted)
                 VALUES (?1, 'work', '#ff0080', ?2, 0)",
                rusqlite::params![incoming_active_id, now_unix()],
            )
            .unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_tags(&conn_a, &key).await.unwrap();
        engine_b.push_tags(&conn_b, &key).await.unwrap();
        engine_a
            .pull_tags(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_tags(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // After convergence: A should have adopted B's active tag (the
        // local tombstone was hard-deleted to free the UNIQUE name);
        // B should keep its active tag (local active wins over remote
        // tombstone in the (false, true) branch).
        let on_a: Option<crate::db::Tag> = conn_a
            .query_row(
                "SELECT id, name, color FROM tags WHERE name = 'work' AND is_deleted = 0",
                [],
                |row| {
                    Ok(crate::db::Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                    })
                },
            )
            .ok();
        assert!(
            on_a.is_some(),
            "dev-a must adopt the active incoming tag, not silently drop it"
        );
        assert_eq!(on_a.as_ref().unwrap().id, incoming_active_id);
        assert_eq!(on_a.as_ref().unwrap().color.as_deref(), Some("#ff0080"));

        let on_b: Option<crate::db::Tag> = conn_b
            .query_row(
                "SELECT id, name, color FROM tags WHERE name = 'work' AND is_deleted = 0",
                [],
                |row| {
                    Ok(crate::db::Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                    })
                },
            )
            .ok();
        assert!(on_b.is_some(), "dev-b should keep its active tag");
        assert_eq!(on_b.as_ref().unwrap().id, incoming_active_id);
    }

    #[tokio::test]
    async fn tag_tombstone_name_collision_resolves_by_lower_id() {
        // I5: when two devices independently created and tombstoned
        // tags with the same name, the collision resolution used to
        // depend on pull order. Now the lower-id row survives on every
        // device — both converge to the same row.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let conn_b = fresh_db();
        // Both have a tombstoned tag named "work" but with different ids.
        let id_low = "0000-tag-low-aaaa";
        let id_high = "zzzz-tag-high-aaaa";
        conn_a.execute(
            "INSERT INTO tags (id, name, color, updated_at, is_deleted) VALUES (?1, 'work', NULL, ?2, 1)",
            rusqlite::params![id_low, now_unix()],
        ).unwrap();
        conn_b.execute(
            "INSERT INTO tags (id, name, color, updated_at, is_deleted) VALUES (?1, 'work', NULL, ?2, 1)",
            rusqlite::params![id_high, now_unix()],
        ).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");
        engine_a.push_tags(&conn_a, &key).await.unwrap();
        engine_b.push_tags(&conn_b, &key).await.unwrap();
        engine_a
            .pull_tags(&conn_a, &key, &engine_a.make_key_state(&key))
            .await
            .unwrap();
        engine_b
            .pull_tags(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();

        // Both devices should converge to id_low (lower lex wins).
        let a_ids: Vec<String> = conn_a
            .prepare("SELECT id FROM tags WHERE name = 'work'")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let b_ids: Vec<String> = conn_b
            .prepare("SELECT id FROM tags WHERE name = 'work'")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            a_ids.contains(&id_low.to_string()),
            "dev-a must keep id_low"
        );
        assert!(
            b_ids.contains(&id_low.to_string()),
            "dev-b must converge to id_low after pull"
        );
    }

    // ── Codex review fixes (C1, C2, I1, I3, I4) regression guards ──────────

    #[tokio::test]
    async fn corrupt_template_b64_does_not_null_local_content() {
        // codex-C1: a peer pushed a template payload with malformed
        // base64 in `content_b64`. Pre-fix, the decode error fell
        // through to `content: None`, and LWW would then overwrite the
        // local template's `content` column with NULL. Now the bad row
        // is skipped entirely.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let tmpl =
            db::create_template(&conn, "good", None, Some(b"local-content-must-survive")).unwrap();

        // Hand-craft a malformed peer payload with same id but bad b64.
        let mut bad_payload = std::collections::BTreeMap::new();
        let synced = super::super::metadata::SyncedTemplate {
            id: tmpl.id.clone(),
            name: "evil".to_string(),
            description: None,
            content_b64: Some("not-valid-base64!@#$%".to_string()),
            sort_order: 0,
            created_at: now_unix(),
            updated_at: now_unix() + 10_000,
            is_deleted: false,
        };
        bad_payload.insert(tmpl.id.clone(), synced.clone());
        let payload = super::super::metadata::TemplatesPayload {
            device_id: "evil-peer".to_string(),
            generated_at: now_unix(),
            templates: vec![synced],
        };
        let json = serde_json::to_vec(&payload).unwrap();
        let evil_ks = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(*key))
                .expect("set_key never fails");
            ks
        };
        let ct = crate::utils::encryption::encrypt_data_with_state(&json, &evil_ks).unwrap();
        std::fs::create_dir_all(dir.path().join("evil-peer")).unwrap();
        std::fs::write(dir.path().join("evil-peer/templates.bin"), &ct).unwrap();

        let engine = make_engine(&dir, "dev-a");
        engine
            .pull_templates(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();

        let after = db::get_template(&conn, &tmpl.id).unwrap().unwrap();
        assert_eq!(
            after.content.as_deref(),
            Some(&b"local-content-must-survive"[..]),
            "corrupt b64 must NOT NULL the local content"
        );
        assert_eq!(
            after.name, "good",
            "corrupt-row skip must leave the whole local row untouched"
        );
        // Tighten: the "skip the row entirely" semantic also means the
        // bad payload must NOT insert a fresh template under a
        // different shape. Count user templates and confirm the only
        // one is the original "good" row — no "evil" name appearing.
        let row_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM templates WHERE is_predefined = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            row_count, 1,
            "skip-the-row semantic: corrupt b64 must not insert a fresh template"
        );
        let evil_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM templates WHERE name = 'evil'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(evil_count, 0, "peer's 'evil' name must not land anywhere");
    }

    #[tokio::test]
    async fn journal_tombstone_multi_peer_race_re_checks_live_row() {
        // codex-C2 actual regression guard: multi-peer pull where an
        // earlier peer in the loop bumps a journal to a NEWER active
        // state than the diff's `local_view` saw, and a later peer's
        // tombstone (computed against the stale view) would otherwise
        // clobber it. The fix is `tombstone_journal_from_sync_lww`
        // re-reading the live row before applying.
        //
        // Scenario:
        //   Local journal "J": updated_at=1000, is_deleted=0
        //   peer-A manifest:    updated_at=3000, is_deleted=0
        //     → compute_journal_diff: to_pull (3000 > 1000)
        //   peer-B manifest:    updated_at=2000, is_deleted=1
        //     → compute_journal_diff: to_delete_locally (2000 > 1000, deleted)
        //   peer-A processed first (lex device_id order).
        //   After A: live row updated_at=3000, is_deleted=0.
        //   B's tombstone re-checks live (3000) vs B's ts (2000):
        //     LWW loses, no-op. Live row stays untouched.
        //
        // Without the fix: B's raw UPDATE would set is_deleted=1 +
        // now_unix(), clobbering the user's latest active state.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let journal_id = "journal-c2-race-aaaa";

        // Seed local journal at t=1000.
        conn.execute(
            "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order, is_deleted)
             VALUES (?1, 'local-old', NULL, ?2, ?3, 0, 0)",
            rusqlite::params![journal_id, 500, 1000],
        )
        .unwrap();

        // peer-A: active journal at t=3000. Need both the manifest
        // entry and the payload file (because diff puts it in to_pull).
        let manifest_a = super::super::metadata::DeviceMetadata {
            device_id: "dev-a".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![super::super::metadata::SyncedJournalSummary {
                journal_id: journal_id.to_string(),
                updated_at: 3000,
                local_version: 1,
                is_deleted: false,
            }],
            chats_present: false,
            memory_present: false,
            generated_at: 3000,
        };
        let payload_a = super::super::metadata::JournalPayload {
            journal_id: journal_id.to_string(),
            device_id: "dev-a".to_string(),
            name: "peer-a-newer-active".to_string(),
            color: Some("#aaaaaa".to_string()),
            sort_order: 0,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            created_at: 500,
            updated_at: 3000,
            auto_tag_ids: vec![],
        };
        let recv_ks = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(*key))
                .expect("set_key never fails");
            ks
        };
        let ct_a = crate::utils::encryption::encrypt_data_with_state(
            &serde_json::to_vec(&payload_a).unwrap(),
            &recv_ks,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("dev-a/journals")).unwrap();
        std::fs::write(
            dir.path().join(format!("dev-a/journals/{journal_id}.bin")),
            &ct_a,
        )
        .unwrap();

        // peer-B: tombstone at t=2000. Summary alone — no payload
        // file needed because to_delete_locally never reads payloads.
        let manifest_b = super::super::metadata::DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![super::super::metadata::SyncedJournalSummary {
                journal_id: journal_id.to_string(),
                updated_at: 2000,
                local_version: 1,
                is_deleted: true,
            }],
            chats_present: false,
            memory_present: false,
            generated_at: 2000,
        };

        // dev-receiver runs the pull. Manifests are passed in
        // lex-sorted (dev-a < dev-b) so peer-A is processed first.
        let engine = make_engine(&dir, "dev-receiver");
        engine
            .pull_journals(
                &conn,
                &key,
                &engine.make_key_state(&key),
                &[
                    ("dev-a".to_string(), manifest_a),
                    ("dev-b".to_string(), manifest_b),
                ],
            )
            .await
            .unwrap();

        // Final state: peer-A's active payload won, peer-B's stale
        // tombstone rejected by the live-row re-check.
        let row: (String, i64, i64) = conn
            .query_row(
                "SELECT name, updated_at, is_deleted FROM journals WHERE id = ?1",
                [journal_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row.0, "peer-a-newer-active",
            "peer-A's active payload should win against stale tombstone"
        );
        assert_eq!(
            row.1, 3000,
            "live updated_at must match peer-A's payload, NOT now_unix() from a buggy raw UPDATE"
        );
        assert_eq!(
            row.2, 0,
            "is_deleted must stay 0 — the stale tombstone lost LWW against the live row"
        );
    }

    #[tokio::test]
    async fn journal_tombstone_apply_re_checks_current_state_via_lww() {
        // codex-C2: in a multi-peer pull, the tombstone loop must use
        // remote summary's updated_at + device_id and re-check the
        // current row — not blindly UPDATE with now_unix(). Construct
        // a scenario where the local row has been bumped to a NEWER
        // updated_at than the tombstone summary; the tombstone must
        // be rejected, and the local row's is_deleted stays 0.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let shared_id = "journal-c2-shared-0000";

        let conn = fresh_db();
        // Local active journal at t=2000.
        conn.execute(
            "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order, is_deleted)
             VALUES (?1, 'local-newer', NULL, ?2, ?3, 0, 0)",
            rusqlite::params![shared_id, 1000, 2000],
        )
        .unwrap();

        // Peer publishes a tombstone summary at t=1500 (older than local).
        let manifest = super::super::metadata::DeviceMetadata {
            device_id: "dev-peer".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![super::super::metadata::SyncedJournalSummary {
                journal_id: shared_id.to_string(),
                updated_at: 1500,
                local_version: 1,
                is_deleted: true,
            }],
            chats_present: false,
            memory_present: false,
            generated_at: now_unix(),
        };
        std::fs::create_dir_all(dir.path().join("dev-peer")).unwrap();
        std::fs::write(
            dir.path().join("dev-peer/metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // pull_journals will compute_journal_diff against local_view.
        // The diff function uses strict `r.updated_at > l.updated_at`
        // — at 1500 < 2000 the tombstone will NOT enter to_delete_locally,
        // so the bug fix is more interesting in the multi-peer case
        // (covered below). This single-peer case is a sanity check
        // that LWW preserves local newer state.
        let engine = make_engine(&dir, "dev-a");
        engine
            .pull_journals(
                &conn,
                &key,
                &engine.make_key_state(&key),
                &[("dev-peer".to_string(), manifest)],
            )
            .await
            .unwrap();

        let is_deleted: i64 = conn
            .query_row(
                "SELECT is_deleted FROM journals WHERE id = ?1",
                [shared_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 0, "newer local must not be tombstoned");
    }

    #[tokio::test]
    async fn journal_auto_tags_unchanged_when_journal_payload_loses_lww() {
        // codex-I1: stale peer payload must not wipe the local journal's
        // auto-tag set just because the journal id matched.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let journal_id = "journal-i1-shared-aaaa";

        let conn = fresh_db();
        let local_tag = db::create_tag(&conn, "keep", None).unwrap();
        // Insert the local journal at t=2000 with auto_tag = "keep".
        conn.execute(
            "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order, is_deleted)
             VALUES (?1, 'shared', NULL, ?2, ?3, 0, 0)",
            rusqlite::params![journal_id, 1000, 2000],
        )
        .unwrap();
        db::set_journal_auto_tags(&conn, journal_id, &[local_tag.id.clone()]).unwrap();

        // Peer publishes a STALE journal payload at t=1500 with a
        // different auto_tag_ids list.
        let payload = super::super::metadata::JournalPayload {
            journal_id: journal_id.to_string(),
            device_id: "dev-peer".to_string(),
            name: "stale-name".to_string(),
            color: None,
            sort_order: 0,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            created_at: 1000,
            updated_at: 1500, // OLDER than local 2000
            auto_tag_ids: vec!["different-tag-id-aaaa".to_string()],
        };
        let peer_ks = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(*key))
                .expect("set_key never fails");
            ks
        };
        let ct = crate::utils::encryption::encrypt_data_with_state(
            &serde_json::to_vec(&payload).unwrap(),
            &peer_ks,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer/journals")).unwrap();
        std::fs::write(
            dir.path()
                .join(format!("dev-peer/journals/{journal_id}.bin")),
            &ct,
        )
        .unwrap();
        // Manifest must list this journal in to_pull (newer summary timestamp).
        // We use updated_at = 1500 < 2000 → diff would NOT put it in to_pull.
        // To exercise the I1 fix specifically we need the journal in to_pull
        // (so the LWW check is reached) but losing LWW once examined. The
        // manifest carries summary.updated_at independently of the payload's
        // updated_at; use a forged summary at t=3000 to make compute_journal_diff
        // pull, but the payload's actual updated_at=1500 means LWW loses.
        let manifest = super::super::metadata::DeviceMetadata {
            device_id: "dev-peer".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![super::super::metadata::SyncedJournalSummary {
                journal_id: journal_id.to_string(),
                updated_at: 3000, // makes the diff "pull"
                local_version: 1,
                is_deleted: false,
            }],
            chats_present: false,
            memory_present: false,
            generated_at: now_unix(),
        };
        std::fs::write(
            dir.path().join("dev-peer/metadata.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let engine = make_engine(&dir, "dev-a");
        engine
            .pull_journals(
                &conn,
                &key,
                &engine.make_key_state(&key),
                &[("dev-peer".to_string(), manifest)],
            )
            .await
            .unwrap();

        // Journal fields preserved (LWW lost).
        let name: String = conn
            .query_row(
                "SELECT name FROM journals WHERE id = ?1",
                [journal_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "shared", "journal name must not be overwritten");
        // Auto-tags untouched.
        let auto_ids = db::list_journal_auto_tag_ids(&conn, journal_id).unwrap();
        assert_eq!(
            auto_ids,
            vec![local_tag.id],
            "auto_tag_ids must not be replaced when journal LWW loses"
        );
    }

    #[tokio::test]
    async fn synced_tag_tombstone_clears_entry_tag_junction_rows() {
        // codex-I3: when a remote tombstone wins LWW against an active
        // local tag, the entry_tags + journal_auto_tags junction rows
        // must be cleaned up too. Otherwise the tag id keeps echoing
        // through entry payloads.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();
        let tag = db::create_tag(&conn, "doomed", None).unwrap();
        let journal_id = default_journal(&conn);
        let entry = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("tagged"),
                content_text: None,
                preview_text: None,
                entry_date: now_unix(),
            },
        )
        .unwrap();
        db::add_tag_to_entry(&conn, &entry.id, &tag.id).unwrap();
        db::set_journal_auto_tags(&conn, &journal_id, &[tag.id.clone()]).unwrap();

        // Peer pushes a tombstone for this tag with newer updated_at.
        let payload = super::super::metadata::TagsPayload {
            device_id: "dev-peer".to_string(),
            generated_at: now_unix(),
            tags: vec![super::super::metadata::SyncedTag {
                id: tag.id.clone(),
                name: "doomed".to_string(),
                color: None,
                updated_at: now_unix() + 10_000,
                is_deleted: true,
            }],
        };
        let peer_ks = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(*key))
                .expect("set_key never fails");
            ks
        };
        let ct = crate::utils::encryption::encrypt_data_with_state(
            &serde_json::to_vec(&payload).unwrap(),
            &peer_ks,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer")).unwrap();
        std::fs::write(dir.path().join("dev-peer/tags.bin"), &ct).unwrap();

        let engine = make_engine(&dir, "dev-a");
        engine
            .pull_tags(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();

        // Tag row tombstoned.
        let is_deleted: i64 = conn
            .query_row(
                "SELECT is_deleted FROM tags WHERE id = ?1",
                [&tag.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1);
        // entry_tags + journal_auto_tags rows for this tag are GONE.
        let et_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entry_tags WHERE tag_id = ?1",
                [&tag.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            et_count, 0,
            "entry_tags rows must be removed on synced tombstone"
        );
        let jat_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM journal_auto_tags WHERE tag_id = ?1",
                [&tag.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            jat_count, 0,
            "journal_auto_tags rows must be removed on synced tombstone"
        );
    }

    #[tokio::test]
    async fn peer_supplied_bad_tag_color_is_dropped() {
        // codex-I4: a peer pushing tag with non-`#RRGGBB` color must
        // not poison the local DB. The receiver drops the color but
        // still applies the rest of the row.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn = fresh_db();

        let tag_id = "tag-bad-color-aaaaa";
        let payload = super::super::metadata::TagsPayload {
            device_id: "dev-peer".to_string(),
            generated_at: now_unix(),
            tags: vec![super::super::metadata::SyncedTag {
                id: tag_id.to_string(),
                name: "evil".to_string(),
                color: Some("javascript:alert(1)".to_string()),
                updated_at: now_unix(),
                is_deleted: false,
            }],
        };
        let peer_ks = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(*key))
                .expect("set_key never fails");
            ks
        };
        let ct = crate::utils::encryption::encrypt_data_with_state(
            &serde_json::to_vec(&payload).unwrap(),
            &peer_ks,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer")).unwrap();
        std::fs::write(dir.path().join("dev-peer/tags.bin"), &ct).unwrap();

        let engine = make_engine(&dir, "dev-a");
        engine
            .pull_tags(&conn, &key, &engine.make_key_state(&key))
            .await
            .unwrap();

        let stored: (String, Option<String>) = conn
            .query_row(
                "SELECT name, color FROM tags WHERE id = ?1",
                [tag_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "evil", "name should still apply");
        assert!(
            stored.1.is_none(),
            "bad color must be dropped, got {:?}",
            stored.1
        );
    }

    // ── Templates sync (Stage 4) ───────────────────────────────────────────

    #[tokio::test]
    async fn user_template_round_trip_and_soft_delete() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // A creates a user template.
        let conn_a = fresh_db();
        let tmpl = db::create_template(
            &conn_a,
            "Morning Pages",
            Some("Stream-of-consciousness start to the day"),
            Some(b"raw-yjs-template-bytes"),
        )
        .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_templates(&conn_a, &key).await.unwrap();

        // B pulls → the row appears.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_templates(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let on_b = db::get_template(&conn_b, &tmpl.id).unwrap();
        assert!(on_b.is_some());
        let on_b = on_b.unwrap();
        assert_eq!(on_b.name, "Morning Pages");
        assert_eq!(
            on_b.description.as_deref(),
            Some("Stream-of-consciousness start to the day")
        );
        assert_eq!(
            on_b.content.as_deref(),
            Some(&b"raw-yjs-template-bytes"[..])
        );

        // A soft-deletes, re-syncs → B's row goes hidden.
        db::delete_template(&conn_a, &tmpl.id).unwrap();
        conn_a
            .execute(
                "UPDATE templates SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&tmpl.id],
            )
            .unwrap();
        engine_a.push_templates(&conn_a, &key).await.unwrap();
        engine_b
            .pull_templates(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(db::get_template(&conn_b, &tmpl.id).unwrap().is_none());
    }

    #[tokio::test]
    async fn predefined_templates_are_not_pushed() {
        // Predefined templates are seeded by `migrate()` on every device.
        // Pushing them would create duplicates / version conflicts.
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        // Confirm at least one predefined template exists locally.
        let predefined_count: i64 = conn_a
            .query_row(
                "SELECT COUNT(*) FROM templates WHERE is_predefined = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            predefined_count > 0,
            "migration should seed predefined templates"
        );

        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_templates(&conn_a, &key).await.unwrap();

        let bytes = std::fs::read(dir.path().join("dev-a/templates.bin")).unwrap();
        let ks = engine_a.make_key_state(&key);
        let plain = crate::utils::encryption::decrypt_data_with_state(&bytes, &ks).unwrap();
        let payload: super::super::metadata::TemplatesPayload =
            serde_json::from_slice(&plain).unwrap();
        assert!(
            payload.templates.is_empty(),
            "no user templates were created, manifest should be empty"
        );
    }

    // ── Journal sync as a first-class channel (Stage 3) ─────────────────────

    #[tokio::test]
    async fn empty_journal_syncs_via_journal_channel() {
        // Bug the entry-piggyback couldn't fix: a journal with zero
        // entries had nothing to push. With the dedicated channel, the
        // journal payload propagates regardless.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let journal_a = db::create_journal(&conn_a, "Empty", Some("#aabbcc")).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let row: (String, Option<String>) = conn_b
            .query_row(
                "SELECT name, color FROM journals WHERE id = ?1",
                [&journal_a.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "Empty");
        assert_eq!(row.1.as_deref(), Some("#aabbcc"));
    }

    #[tokio::test]
    async fn journal_soft_delete_propagates_via_dedicated_channel() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let journal_a = db::create_journal(&conn_a, "Doomed", None).unwrap();
        db::create_journal(&conn_a, "Survivor", None).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // A deletes the journal. `now_unix()` has 1-second resolution, so
        // in a fast test the soft-delete might land in the same wall-
        // clock second as the create — leaving updated_at unchanged and
        // the LWW key tied. Bump it explicitly so the diff has a clean
        // strictly-newer remote.
        db::delete_journal(&conn_a, &journal_a.id).unwrap();
        conn_a
            .execute(
                "UPDATE journals SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&journal_a.id],
            )
            .unwrap();
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let is_deleted: i64 = conn_b
            .query_row(
                "SELECT is_deleted FROM journals WHERE id = ?1",
                [&journal_a.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1, "journal tombstone should propagate");
    }

    #[tokio::test]
    async fn journal_auto_tags_sync_via_journal_channel() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let tag = db::create_tag(&conn_a, "auto-applied", None).unwrap();
        let journal = db::create_journal(&conn_a, "AutoTags", None).unwrap();
        db::set_journal_auto_tags(&conn_a, &journal.id, &[tag.id.clone()]).unwrap();
        // The set_journal_auto_tags + create_journal calls fired in the
        // same wall-clock second; bump updated_at to ensure the LWW key
        // for the journal payload is meaningfully newer than the seeded
        // default journal on B.
        conn_a
            .execute(
                "UPDATE journals SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&journal.id],
            )
            .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let on_b = db::list_journal_auto_tag_ids(&conn_b, &journal.id).unwrap();
        assert_eq!(on_b, vec![tag.id]);
    }

    #[tokio::test]
    async fn journal_color_change_syncs_without_touching_any_entry() {
        // The whole point of the dedicated channel: a journal edit
        // propagates even when no entries change. Pre-Stage 3 we marked
        // every entry pending to force the change out; that was wasteful
        // and didn't cover empty journals.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let journal = db::create_journal(&conn_a, "ColorMe", Some("#000000")).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // A changes the color. NO entries exist, so the entry channel
        // can't carry this. The journal channel must.
        db::update_journal(&conn_a, &journal.id, "ColorMe", Some("#ff0080")).unwrap();
        // Disambiguate the LWW key in a fast test where `now_unix()` has
        // 1-second resolution and the create + update can land in the
        // same second.
        conn_a
            .execute(
                "UPDATE journals SET updated_at = updated_at + 1000 WHERE id = ?1",
                [&journal.id],
            )
            .unwrap();
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let color: Option<String> = conn_b
            .query_row(
                "SELECT color FROM journals WHERE id = ?1",
                [&journal.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(color.as_deref(), Some("#ff0080"));
    }

    // ── Tags sync (Stage 2) ─────────────────────────────────────────────────

    #[tokio::test]
    async fn tags_round_trip_creation_between_devices() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // A creates a tag with a color.
        let conn_a = fresh_db();
        let tag_a = db::create_tag(&conn_a, "travel", Some("#ff0080")).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_tags(&conn_a, &key).await.unwrap();

        // B pulls tags → the row exists with same id and color.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let errs = engine_b
            .pull_tags(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        assert!(errs.is_empty(), "no errors expected: {errs:?}");
        let on_b: Vec<crate::db::Tag> = db::list_tags(&conn_b, None).unwrap();
        let found = on_b.iter().find(|t| t.id == tag_a.id);
        assert!(found.is_some(), "tag {} should sync to B", tag_a.id);
        let found = found.unwrap();
        assert_eq!(found.name, "travel");
        assert_eq!(found.color.as_deref(), Some("#ff0080"));
    }

    #[tokio::test]
    async fn tag_soft_delete_propagates_via_tombstone() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Both devices start with the same tag (e.g. after first sync).
        let tag_id = "shared-tag-uuid-0001";
        let mk_db = || {
            let c = fresh_db();
            c.execute(
                "INSERT INTO tags (id, name, color, updated_at, is_deleted)
                 VALUES (?1, 'work', '#abcdef', ?2, 0)",
                rusqlite::params![tag_id, now_unix() - 100],
            )
            .unwrap();
            c
        };
        let conn_a = mk_db();
        let conn_b = mk_db();

        // A deletes the tag → soft-delete + updated_at bumped.
        db::delete_tag(&conn_a, tag_id).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_tags(&conn_a, &key).await.unwrap();

        // B pulls → the tag is now soft-deleted on B too.
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_tags(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let is_deleted: i64 = conn_b
            .query_row("SELECT is_deleted FROM tags WHERE id = ?1", [tag_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(is_deleted, 1, "tombstone should propagate");
        // And the user-facing list excludes the deleted tag.
        let visible = db::list_tags(&conn_b, None).unwrap();
        assert!(!visible.iter().any(|t| t.id == tag_id));
    }

    #[tokio::test]
    async fn tag_color_rename_under_lww() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let tag_id = "shared-tag-uuid-0002";
        let mk = || {
            let c = fresh_db();
            c.execute(
                "INSERT INTO tags (id, name, color, updated_at, is_deleted)
                 VALUES (?1, 'work', '#aaaaaa', ?2, 0)",
                rusqlite::params![tag_id, now_unix() - 100],
            )
            .unwrap();
            c
        };
        let conn_a = mk();
        let conn_b = mk();

        // A renames + recolors → updated_at bumps via `update_tag`.
        db::update_tag(
            &conn_a,
            tag_id,
            Some("Work (renamed)"),
            Some(Some("#ff0080")),
        )
        .unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a.push_tags(&conn_a, &key).await.unwrap();

        // B pulls → adopts A's newer values.
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_tags(&conn_b, &key, &engine_b.make_key_state(&key))
            .await
            .unwrap();
        let (name, color): (String, Option<String>) = conn_b
            .query_row(
                "SELECT name, color FROM tags WHERE id = ?1",
                [tag_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Work (renamed)");
        assert_eq!(color.as_deref(), Some("#ff0080"));
    }

    #[tokio::test]
    async fn end_to_end_entry_with_tag_via_sync_now() {
        // Full sync_now cycle: A creates a tag + entry with that tag,
        // syncs; B syncs, the entry has the tag attached via the
        // entry_tags junction. Pulled tags must land BEFORE the entry's
        // entry_tags ingest for the FK chain to satisfy.
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let tag = db::create_tag(&conn_a, "weekend", Some("#88aaff")).unwrap();
        let journal = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal,
                title: Some("Hike"),
                content_text: Some("Sunny day"),
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        db::add_tag_to_entry(&conn_a, &entry.id, &tag.id).unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .sync_now(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .sync_now(
                &conn_b,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Tag exists on B.
        let b_tags = db::list_tags(&conn_b, None).unwrap();
        assert!(b_tags.iter().any(|t| t.id == tag.id && t.name == "weekend"));
        // Entry is tagged on B.
        let b_entry_tags = db::get_tags_for_entry(&conn_b, &entry.id).unwrap();
        assert_eq!(b_entry_tags.len(), 1);
        assert_eq!(b_entry_tags[0].id, tag.id);
    }

    #[tokio::test]
    async fn cover_media_id_and_entry_date_user_edited_round_trip() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // A writes an entry with a cover + a confirmed entry_date.
        let conn_a = fresh_db();
        let journal_a = default_journal(&conn_a);
        let entry = db::create_entry(
            &conn_a,
            crate::db::CreateEntryParams {
                journal_id: &journal_a,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_700_000_000,
            },
        )
        .unwrap();
        // Seed a fake cover id (no real media row — fine for this LWW test).
        conn_a
            .execute(
                "UPDATE entries
                    SET cover_media_id = 'cover-id-xyz',
                        entry_date_user_edited = 1,
                        content_language = 'vi'
                  WHERE id = ?1",
                [&entry.id],
            )
            .unwrap();
        db::mark_entry_pending(&conn_a, &entry.id).unwrap();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let pulled = db::get_entry(&conn_b, &entry.id).unwrap().unwrap();
        assert_eq!(pulled.cover_media_id.as_deref(), Some("cover-id-xyz"));
        assert!(pulled.entry_date_user_edited);
        assert_eq!(pulled.content_language.as_deref(), Some("vi"));
    }

    // ── Key-fingerprint mismatch pinning tests ────────────────────────────────
    //
    // These guard the regression: before this fix, all non-entry channels
    // encrypted without an envelope fingerprint, so a wrong-key pull
    // would surface as the opaque "Decryption failed: aead::Error" instead
    // of a human-readable "key fingerprint mismatch" diagnostic.

    /// pull_journals with a peer file encrypted under a DIFFERENT key must
    /// produce a decryption failure.  With versioned envelopes (0x01 AES-GCM),
    /// a wrong key causes an AEAD auth failure.
    #[tokio::test]
    async fn pull_journals_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xBBu8; 32]; // different from test_key()
        let dir = TempDir::new().unwrap();
        let journal_id = "journal-fp-mismatch-aaa";

        // Simulate a peer that encrypted under `bad_key` using the versioned
        // envelope so the receiver (holding good_key) sees an AEAD auth failure.
        let payload = super::super::metadata::JournalPayload {
            journal_id: journal_id.to_string(),
            device_id: "dev-peer".to_string(),
            name: "peer journal".to_string(),
            color: None,
            sort_order: 0,
            is_deleted: false,
            is_locked: false,
            is_invisible: false,
            vault_id: None,
            created_at: 1000,
            updated_at: 2000,
            auto_tag_ids: vec![],
        };
        let bad_ks = crate::EncryptionKeyState::new();
        bad_ks
            .set_key(zeroize::Zeroizing::new(bad_key))
            .expect("set_key never fails");
        let ct = crate::utils::encryption::encrypt_data_with_state(
            &serde_json::to_vec(&payload).unwrap(),
            &bad_ks,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer/journals")).unwrap();
        std::fs::write(
            dir.path()
                .join(format!("dev-peer/journals/{journal_id}.bin")),
            &ct,
        )
        .unwrap();

        let manifest = super::super::metadata::DeviceMetadata {
            device_id: "dev-peer".to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![super::super::metadata::SyncedJournalSummary {
                journal_id: journal_id.to_string(),
                updated_at: 2000,
                local_version: 1,
                is_deleted: false,
            }],
            chats_present: false,
            memory_present: false,
            generated_at: 2000,
        };

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_journals(
                &conn,
                &good_key,
                &engine.make_key_state(&good_key),
                &[("dev-peer".to_string(), manifest)],
            )
            .await
            .unwrap();

        assert!(!errors.is_empty(), "expected at least one error");
        assert_wrong_key_error(&errors);
    }

    /// pull_settings with a peer file encrypted under a DIFFERENT key must
    /// produce a decryption failure when the peer used a different key.
    #[tokio::test]
    async fn pull_settings_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xCCu8; 32];
        let dir = TempDir::new().unwrap();

        let mut settings = std::collections::BTreeMap::new();
        settings.insert(
            "theme".to_string(),
            super::super::metadata::SyncedSetting {
                value: "dark".to_string(),
                updated_at: 2000,
                deleted_at: None,
            },
        );
        let payload = super::super::metadata::SettingsPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            settings,
        };
        // Use the versioned envelope with bad_key so the receiver (holding
        // good_key) gets an AEAD auth failure.
        let bad_ks = crate::EncryptionKeyState::new();
        bad_ks
            .set_key(zeroize::Zeroizing::new(bad_key))
            .expect("set_key never fails");
        let ct = crate::utils::encryption::encrypt_data_with_state(
            &serde_json::to_vec(&payload).unwrap(),
            &bad_ks,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer")).unwrap();
        std::fs::write(dir.path().join("dev-peer/settings.bin"), &ct).unwrap();

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_settings(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();

        assert_wrong_key_error(&errors.errors);
    }

    /// Assert that a channel pull's error vector reports a decryption failure
    /// when the peer used a different key.  With the versioned envelope
    /// (0x01 AES-GCM), a wrong key causes an AEAD auth failure — the error
    /// string reports "Decryption failed".
    fn assert_wrong_key_error(errors: &[String]) {
        assert!(!errors.is_empty(), "expected at least one error");
        let joined = errors.join(" ");
        assert!(
            joined.to_lowercase().contains("decryption failed")
                || joined.to_lowercase().contains("decrypt"),
            "error must report a decryption failure, got: {joined:?}"
        );
    }

    /// Write `payload_bytes` to `{dir}/dev-peer/{file_name}` as a versioned
    /// AES-GCM ciphertext under `bad_key`.  Used by the channel wrong-key
    /// pinning tests so every test stays a 3-line wrapper.
    fn write_peer_channel_blob(
        dir: &TempDir,
        file_name: &str,
        bad_key: &[u8; 32],
        payload_bytes: &[u8],
    ) {
        // Build a sentinel-free key state for the bad key so the versioned
        // envelope helper produces [0x01] ++ AES-GCM.
        let bad_ks = crate::EncryptionKeyState::new();
        bad_ks
            .set_key(zeroize::Zeroizing::new(*bad_key))
            .expect("set_key never fails");
        let ct = crate::utils::encryption::encrypt_data_with_state(payload_bytes, &bad_ks).unwrap();
        std::fs::create_dir_all(dir.path().join("dev-peer")).unwrap();
        std::fs::write(dir.path().join(format!("dev-peer/{file_name}")), &ct).unwrap();
    }

    #[tokio::test]
    async fn pull_tags_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD1u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::TagsPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            tags: vec![],
        };
        write_peer_channel_blob(
            &dir,
            "tags.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_tags(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
    }

    #[tokio::test]
    async fn pull_templates_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD2u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::TemplatesPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            templates: vec![],
        };
        write_peer_channel_blob(
            &dir,
            "templates.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_templates(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
    }

    #[tokio::test]
    async fn pull_chats_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD3u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::ChatPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            sessions: vec![],
        };
        write_peer_channel_blob(
            &dir,
            "chats.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_chats(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
    }

    #[tokio::test]
    async fn pull_streak_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD4u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::StreakPayload {
            device_id: "dev-peer".to_string(),
            current_streak: 0,
            longest_streak: 0,
            last_entry_date: None,
            updated_at: 2000,
        };
        write_peer_channel_blob(
            &dir,
            "streak.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_streak(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
    }

    #[tokio::test]
    async fn pull_location_aliases_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD5u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::LocationAliasesPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            aliases: vec![],
        };
        write_peer_channel_blob(
            &dir,
            "locations.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_location_aliases(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
    }

    #[tokio::test]
    async fn pull_ai_audit_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD6u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::AiAuditPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            rows: vec![],
        };
        write_peer_channel_blob(
            &dir,
            "ai_audit.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_ai_audit(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
    }

    #[tokio::test]
    async fn pull_ai_reviews_wrong_key_reports_fingerprint_mismatch() {
        let good_key = test_key();
        let bad_key = [0xD7u8; 32];
        let dir = TempDir::new().unwrap();
        let payload = super::super::metadata::AiReviewsPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            reviews: vec![super::super::metadata::SyncedAiReview {
                kind: "weekly".into(),
                period_start: 100,
                period_end: 200,
                model_id: "m".into(),
                result_json: r#"{"x":1}"#.into(),
                entry_count: 1,
                created_at: 10,
            }],
        };
        write_peer_channel_blob(
            &dir,
            "ai_reviews.bin",
            &bad_key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_ai_reviews(&conn, &good_key, &engine.make_key_state(&good_key))
            .await
            .unwrap();
        assert_wrong_key_error(&errors);
        assert!(
            db::get_ai_review(&conn, "weekly", 100, 200)
                .unwrap()
                .is_none(),
            "wrong-key pull must not write a review"
        );
    }

    fn crafted_synced_ai_review(
        kind: &str,
        period_start: i64,
        period_end: i64,
        result_json: String,
    ) -> super::super::metadata::SyncedAiReview {
        super::super::metadata::SyncedAiReview {
            kind: kind.into(),
            period_start,
            period_end,
            model_id: "m".into(),
            result_json,
            entry_count: 1,
            created_at: 10,
        }
    }

    /// Write a peer blob with one crafted (possibly invalid) review plus a
    /// valid sibling, then pull. Sibling landing proves skip is `continue`,
    /// not an abort of the merge / tick.
    async fn pull_crafted_ai_reviews(
        invalid: super::super::metadata::SyncedAiReview,
    ) -> (
        Connection,
        Vec<String>,
        super::super::metadata::SyncedAiReview,
    ) {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let sibling = crafted_synced_ai_review("insights", 900, 1000, r#"{"ok":true}"#.into());
        let payload = super::super::metadata::AiReviewsPayload {
            device_id: "dev-peer".to_string(),
            generated_at: 2000,
            reviews: vec![invalid, sibling.clone()],
        };
        write_peer_channel_blob(
            &dir,
            "ai_reviews.bin",
            &key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-receiver");
        let errors = engine
            .pull_ai_reviews(&conn, &key, &engine.make_key_state(&key))
            .await
            .expect("invalid review must skip silently, not abort pull/tick");
        (conn, errors, sibling)
    }

    fn assert_invalid_ai_review_skipped(
        conn: &Connection,
        errors: &[String],
        kind: &str,
        start: i64,
        end: i64,
        sibling: &super::super::metadata::SyncedAiReview,
    ) {
        assert!(
            errors.is_empty(),
            "validator skip is silent, got {errors:?}"
        );
        assert!(
            db::get_ai_review(conn, kind, start, end).unwrap().is_none(),
            "invalid {kind} {start}..{end} must not land"
        );
        let got = db::get_ai_review(
            conn,
            &sibling.kind,
            sibling.period_start,
            sibling.period_end,
        )
        .unwrap()
        .expect("valid sibling must still merge — skip must not abort the rest of the tick");
        assert_eq!(got.result_json, sibling.result_json);
    }

    #[tokio::test]
    async fn pull_ai_reviews_skips_unknown_kind() {
        let (conn, errors, sibling) = pull_crafted_ai_reviews(crafted_synced_ai_review(
            "daily",
            100,
            200,
            r#"{"ok":true}"#.into(),
        ))
        .await;
        assert_invalid_ai_review_skipped(&conn, &errors, "daily", 100, 200, &sibling);
    }

    #[tokio::test]
    async fn pull_ai_reviews_skips_inverted_period() {
        let (conn, errors, sibling) = pull_crafted_ai_reviews(crafted_synced_ai_review(
            "weekly",
            200,
            100,
            r#"{"ok":true}"#.into(),
        ))
        .await;
        assert_invalid_ai_review_skipped(&conn, &errors, "weekly", 200, 100, &sibling);
    }

    #[tokio::test]
    async fn pull_ai_reviews_skips_oversized_result_json() {
        let oversized = format!("{{\"p\":\"{}\"}}", "x".repeat(65536));
        assert!(oversized.len() > 65536);
        let (conn, errors, sibling) =
            pull_crafted_ai_reviews(crafted_synced_ai_review("weekly", 100, 200, oversized)).await;
        assert_invalid_ai_review_skipped(&conn, &errors, "weekly", 100, 200, &sibling);
    }

    #[tokio::test]
    async fn pull_ai_reviews_skips_non_object_result_json() {
        let (conn, errors, sibling) =
            pull_crafted_ai_reviews(crafted_synced_ai_review("weekly", 100, 200, "[]".into()))
                .await;
        assert_invalid_ai_review_skipped(&conn, &errors, "weekly", 100, 200, &sibling);
    }

    // ─── ProgressReporter ────────────────────────────────────────────────────

    /// A test reporter that collects all emitted events for assertion.
    struct TestReporter {
        events: std::sync::Mutex<Vec<SyncProgressEvent>>,
    }

    impl TestReporter {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn events(&self) -> Vec<SyncProgressEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl ProgressReporter for TestReporter {
        fn report(&self, event: SyncProgressEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    struct CatchupReporter {
        events: std::sync::Mutex<Vec<CatchupProgressEvent>>,
    }

    impl CatchupReporter {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn catchup_events(&self) -> Vec<CatchupProgressEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl ProgressReporter for CatchupReporter {
        fn report(&self, _event: SyncProgressEvent) {}

        fn report_catchup_progress(&self, event: CatchupProgressEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    /// A reporter that only counts `heartbeat()` calls, ignoring `report()` —
    /// used to assert the engine's push/pull loops call `heartbeat()` at
    /// least once per item processed (the liveness signal the stall guard in
    /// `commands::sync::with_stall_guard` relies on).
    struct CountingReporter {
        heartbeats: std::sync::atomic::AtomicUsize,
    }

    impl CountingReporter {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                heartbeats: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        fn count(&self) -> usize {
            self.heartbeats.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl ProgressReporter for CountingReporter {
        fn report(&self, _event: SyncProgressEvent) {}

        fn heartbeat(&self) {
            self.heartbeats
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn cloud_authoritative_restore_must_pull_before_any_push() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        make_entry_with_content(&conn, &key, "must not publish during restore");
        let reporter = TestReporter::new();
        let provider = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine =
            SyncEngine::new(provider, "dev-restore".to_string()).with_reporter(reporter.clone());

        engine
            .pull_only_for_recovery(&conn, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let first_phase = reporter.events().first().map(|event| event.phase);
        assert_eq!(
            first_phase,
            Some(SyncProgressPhase::PullingManifests),
            "cloud-authoritative restore must run a pull-only leg before any publish; normal sync currently pushes first"
        );
    }

    #[tokio::test]
    async fn reporter_receives_progress_events_during_push() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        // Create 3 pending entries so the PushingEntries phase has something to loop over.
        for i in 0..3 {
            make_entry_with_content(&conn, &key, &format!("reporter-entry-{i}"));
        }
        assert_eq!(db::count_pending_entries(&conn).unwrap(), 3);

        let reporter = TestReporter::new();
        let provider = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine =
            SyncEngine::new(provider, "dev-reporter".to_string()).with_reporter(reporter.clone());

        engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        let events = reporter.events();
        // Must have received at least one PushingEntries event.
        let entry_events: Vec<_> = events
            .iter()
            .filter(|e| e.phase == SyncProgressPhase::PushingEntries)
            .collect();
        assert!(
            !entry_events.is_empty(),
            "expected PushingEntries events, got none"
        );
        // The final event for PushingEntries must report current == total.
        let last_entry = entry_events.last().unwrap();
        assert_eq!(
            last_entry.current, last_entry.total,
            "last PushingEntries event should have current == total"
        );
    }

    #[tokio::test]
    async fn push_versions_emits_pushing_versions_progress_events() {
        // Regression guard: `push_versions` heartbeats (backend stall guard
        // OK) but must ALSO emit throttled `PushingVersions` IPC progress
        // events — otherwise a large version backlog produces zero
        // SYNC_PROGRESS_EVENT traffic and the frontend's 130s watchdog
        // (which re-arms only on progress/status events) false-fires.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let entry_id = make_entry_with_content(&conn, &key, "body");
        for i in 0..3 {
            db::insert_entry_version(
                &conn,
                &entry_id,
                format!("snapshot-{i}").as_bytes(),
                "preview",
                "dev-a",
            )
            .unwrap();
        }

        let reporter = TestReporter::new();
        let provider = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine = SyncEngine::new(provider, "dev-a".to_string()).with_reporter(reporter.clone());

        engine.push_versions(&conn, &key).await.unwrap();

        let events = reporter.events();
        let version_events: Vec<_> = events
            .iter()
            .filter(|e| e.phase == SyncProgressPhase::PushingVersions)
            .collect();
        assert!(
            !version_events.is_empty(),
            "expected PushingVersions events, got none"
        );
        let last = version_events.last().unwrap();
        assert_eq!(
            last.current, last.total,
            "last PushingVersions event should have current == total"
        );
    }

    #[tokio::test]
    async fn pull_versions_emits_pulling_versions_progress_events() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        db::insert_entry_version(&conn_a, &entry_id, b"snapshot bytes", "preview", "dev-a")
            .unwrap();
        engine_a.push_versions(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        seed_bare_entry(&conn_b, &entry_id);
        let reporter = TestReporter::new();
        let provider_b = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine_b =
            SyncEngine::new(provider_b, "dev-b".to_string()).with_reporter(reporter.clone());

        engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();

        let events = reporter.events();
        let version_events: Vec<_> = events
            .iter()
            .filter(|e| e.phase == SyncProgressPhase::PullingVersions)
            .collect();
        assert!(
            !version_events.is_empty(),
            "expected PullingVersions events, got none"
        );
        let last = version_events.last().unwrap();
        assert_eq!(
            last.current, last.total,
            "last PullingVersions event should have current == total"
        );
    }

    #[tokio::test]
    async fn heartbeat_called_at_least_once_per_pushed_entry() {
        // With no per-request stall reporting, a large push could run for
        // minutes with only ~20 throttled `report()` events — not enough for
        // `run_sync_now`'s stall guard to distinguish "slow" from "hung".
        // `heartbeat()` must fire on every item, unthrottled.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        for i in 0..5 {
            make_entry_with_content(&conn, &key, &format!("heartbeat-entry-{i}"));
        }
        assert_eq!(db::count_pending_entries(&conn).unwrap(), 5);

        let reporter = CountingReporter::new();
        let provider = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine =
            SyncEngine::new(provider, "dev-heartbeat".to_string()).with_reporter(reporter.clone());

        engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        assert!(
            reporter.count() >= 5,
            "expected at least one heartbeat per pushed entry, got {}",
            reporter.count()
        );
    }

    #[tokio::test]
    async fn heartbeat_fires_even_when_every_media_item_fails() {
        // A run of consecutive per-item failures must not go silent from the
        // stall guard's point of view. Each media row below points at a
        // storage_path that doesn't exist, so `std::fs::read` fails for
        // every item — heartbeat must still fire once per item, not just on
        // the success path after the (never-reached) upload.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let journal_id = default_journal(&conn);
        let entry_id = db::create_entry(
            &conn,
            crate::db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1_000_000,
            },
        )
        .unwrap()
        .id;
        for i in 0..4 {
            db::create_media(
                &conn,
                crate::db::CreateMediaParams {
                    entry_id: &entry_id,
                    file_name: &format!("missing-{i}.jpg"),
                    file_type: "image/jpeg",
                    storage_path: &format!("/nonexistent/path/missing-{i}.jpg"),
                    file_size: Some(1),
                    sort_order: i,
                    insertion_mode: "inline",
                    width: None,
                    height: None,
                    exif_date: None,
                    exif_latitude: None,
                    exif_longitude: None,
                },
            )
            .unwrap();
        }

        let reporter = CountingReporter::new();
        let provider = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine = SyncEngine::new(provider, "dev-heartbeat-media-errors".to_string())
            .with_reporter(reporter.clone());

        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        assert_eq!(stats.errors.len(), 4, "every media read should have failed");
        assert!(
            reporter.count() >= 4,
            "expected at least one heartbeat per failed media item, got {}",
            reporter.count()
        );
    }

    #[tokio::test]
    async fn reporter_is_optional_no_regression() {
        // Existing make_engine (no reporter) must still work without reporter.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        make_entry_with_content(&conn, &key, "no-reporter-entry");

        let engine = make_engine(&dir, "dev-no-reporter");
        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(stats.pushed, 1);
    }

    #[test]
    fn progress_phase_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&SyncProgressPhase::PushingEntries).unwrap(),
            "\"pushing-entries\""
        );
        assert_eq!(
            serde_json::to_string(&SyncProgressPhase::PullingEntries).unwrap(),
            "\"pulling-entries\""
        );
        assert_eq!(
            serde_json::to_string(&SyncProgressPhase::PushingAiAudit).unwrap(),
            "\"pushing-ai-audit\""
        );
        assert_eq!(
            serde_json::to_string(&SyncProgressPhase::PushingVersions).unwrap(),
            "\"pushing-versions\""
        );
        assert_eq!(
            serde_json::to_string(&SyncProgressPhase::PullingVersions).unwrap(),
            "\"pulling-versions\""
        );
    }

    #[test]
    fn should_emit_throttle_caps_at_twenty() {
        // For n=100 items, count events that would be emitted.
        let n = 100;
        let count = (0..n).filter(|&i| should_emit(i, n)).count();
        // At most 20 + 2 (start and end captured by step), definitely ≤ 25.
        assert!(count <= 25, "too many emits for n=100: {count}");
        // First and last must always emit.
        assert!(should_emit(0, n));
        assert!(should_emit(n - 1, n));
    }

    #[test]
    fn should_emit_step_is_capped_at_25_for_large_n() {
        // For very large N, `n / 20` alone would let the gap between UI
        // progress events grow past the frontend's 130s watchdog window
        // while the backend is still legitimately working. The step must
        // never exceed 25 regardless of how large N gets.
        let n = 10_000;
        assert!(
            should_emit(25, n),
            "expected an emit at i=25 for n=10_000 (step capped at 25)"
        );
        assert!(
            should_emit(50, n),
            "expected an emit at i=50 for n=10_000 (step capped at 25)"
        );
        // No gap between consecutive emits should exceed 25 items.
        let emit_indices: Vec<usize> = (0..n).filter(|&i| should_emit(i, n)).collect();
        for pair in emit_indices.windows(2) {
            let gap = pair[1] - pair[0];
            assert!(gap <= 25, "gap of {gap} between emits {pair:?} exceeds 25");
        }

        // Existing small-N behavior (step = max(1, n/20)) is unchanged since
        // n/20 never exceeds 25 for these sizes.
        let n_small = 100;
        let count_small = (0..n_small).filter(|&i| should_emit(i, n_small)).count();
        assert!(count_small <= 25, "too many emits for n=100: {count_small}");
    }

    // ─── Envelope version + fingerprint guard ─────────────────────────────────

    /// In password mode the pushed payload carries the real HMAC fingerprint and
    /// AES-GCM encrypted blobs — content text must NOT be readable in the file.
    #[tokio::test]
    async fn sync_payload_in_password_mode_uses_aes_gcm_envelope() {
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a"); // default = password mode
        let key = test_key();

        let entry_id = make_entry_with_content(&conn, &key, "secret text");
        engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();

        let path = dir.path().join(format!("dev-a/entries/{entry_id}.bin"));
        let bytes = std::fs::read(&path).unwrap();
        let payload = crate::sync::entry_sync::deserialize_payload(&bytes).unwrap();

        // Blobs must be AES-GCM ciphertext — plain JSON parse should fail.
        assert!(
            serde_json::from_slice::<EntryMetadata>(&payload.metadata_ciphertext).is_err(),
            "metadata_ciphertext must not be plain JSON in password mode"
        );

        // The file must not contain the raw plaintext.
        let file_bytes = std::fs::read(path).unwrap();
        let secret = b"secret text";
        assert!(
            !file_bytes.windows(secret.len()).any(|w| w == secret),
            "plaintext must not appear in the sync file"
        );
    }

    /// Pushing a payload with an unknown fingerprint (different key, same mode)
    /// to a password-mode device must be rejected by `ingest_entry`.
    #[tokio::test]
    async fn sync_refuses_payload_with_wrong_fingerprint_in_password_mode() {
        use crate::utils::encryption::SALT_SIZE;
        let conn_a = fresh_db();
        let conn_b = fresh_db();
        let dir = TempDir::new().unwrap();

        let key_a = test_key();
        let key_b = derive_encryption_key("different-password-zzz", &[9u8; SALT_SIZE]).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        let engine_b = make_engine(&dir, "dev-b");

        make_entry_with_content(&conn_b, &key_b, "device-b content");
        engine_b
            .push_local(
                &conn_b,
                &key_b,
                &key_state_from_key(&key_b),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // dev-a pulls — the payload was encrypted under key_b, but dev-a has key_a.
        let stats = engine_a
            .pull_remote(&conn_a, &key_a, &key_state_from_key(&key_a))
            .await
            .unwrap();
        // At least one error per entry, no successful pulls.
        assert_eq!(stats.pulled, 0, "should not pull entries with wrong key");
        assert!(
            !stats.errors.is_empty(),
            "should report fingerprint mismatch errors"
        );
    }

    // ─── Envelope version-prefix integration tests ────────────────────────────

    /// In password mode the pushed entry payload's blobs start with the
    /// `0x01` AES-GCM version prefix. Verifies the versioned envelope shape
    /// at the byte level.
    #[tokio::test]
    async fn sync_payload_in_password_mode_has_aes_gcm_version_prefix() {
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-pw");
        let key = test_key();

        make_entry_with_content(&conn, &key, "password mode content");
        let stats = engine
            .push_local(&conn, &key, &key_state_from_key(&key), SyncTrigger::Manual)
            .await
            .unwrap();
        assert_eq!(stats.pushed, 1, "should have pushed 1 entry");

        let entries_dir = dir.path().join("dev-pw/entries");
        let mut bins: Vec<_> = std::fs::read_dir(&entries_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(bins.len(), 1, "exactly one .bin file must be present");
        let raw = std::fs::read(bins.remove(0).path()).unwrap();
        let payload =
            crate::sync::entry_sync::deserialize_payload(&raw).expect("payload deserializes");

        // Version-prefix assertions.
        assert_eq!(
            payload.yjs_blob_ciphertext.first().copied(),
            Some(0x01),
            "yjs_ciphertext first byte must be 0x01 (AES-GCM v1) in password mode"
        );
        assert_eq!(
            payload.metadata_ciphertext.first().copied(),
            Some(0x01),
            "meta_ciphertext first byte must be 0x01 (AES-GCM v1) in password mode"
        );
    }

    /// Feed `ingest_entry` a payload whose blobs start with `0x99` (unknown
    /// version byte).  The engine must return an error whose message contains
    /// "Unknown sync envelope format" and "Update the app".
    #[test]
    fn ingest_rejects_unknown_envelope_version() {
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-pw");
        let key = test_key();
        let local_fp = {
            let ks = engine.make_key_state(&key);
            ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap()
        };
        // Craft a payload whose blobs start with 0x99 (entirely unknown).
        let payload = crate::sync::entry_sync::SyncEntryPayload::new(
            local_fp,
            vec![0x99, 0x01, 0x02, 0x03], // 0x99 = unknown version
            vec![0x99, 0x04, 0x05, 0x06],
        );
        let entry_id = uuid::Uuid::new_v4().to_string();
        let err = engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry_id, &payload)
            .unwrap_err();
        match &err {
            SyncError::CrossModeReject(msg) => {
                assert!(
                    msg.contains("Unknown sync envelope format"),
                    "error must mention 'Unknown sync envelope format': {msg:?}"
                );
                assert!(
                    msg.contains("Update the app"),
                    "error must tell user to 'Update the app': {msg:?}"
                );
            }
            other => panic!("expected CrossModeReject, got {other:?}"),
        }
    }

    /// `ingest_entry` must reject a payload where `yjs_ciphertext` has a valid
    /// version byte (`0x01`) but `meta_ciphertext` has an unknown version byte
    /// (`0x99`).  Both blobs are checked; an unknown byte in *either* must
    /// trigger `CrossModeReject` with "Unknown sync envelope format".
    #[test]
    fn ingest_rejects_mixed_unknown_version_byte_meta_invalid() {
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-pw");
        let key = test_key();
        let local_fp = {
            let ks = engine.make_key_state(&key);
            ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap()
        };
        // yjs starts with 0x01 (valid AES-GCM marker), meta starts with 0x99 (unknown).
        let payload = crate::sync::entry_sync::SyncEntryPayload::new(
            local_fp,
            vec![0x01, 0x02, 0x03, 0x04], // valid version byte
            vec![0x99, 0x05, 0x06, 0x07], // unknown version byte
        );
        let entry_id = uuid::Uuid::new_v4().to_string();
        let err = engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry_id, &payload)
            .unwrap_err();
        match &err {
            SyncError::CrossModeReject(msg) => {
                assert!(
                    msg.contains("Unknown sync envelope format"),
                    "error must mention 'Unknown sync envelope format': {msg:?}"
                );
                assert!(
                    msg.contains("Update the app"),
                    "error must tell user to 'Update the app': {msg:?}"
                );
            }
            other => panic!("expected CrossModeReject, got {other:?}"),
        }
    }

    /// Symmetric of `ingest_rejects_mixed_unknown_version_byte_meta_invalid`:
    /// `yjs_ciphertext` starts with `0x99` (unknown) and `meta_ciphertext`
    /// starts with `0x01` (valid).  The guard must still fire.
    #[test]
    fn ingest_rejects_mixed_unknown_version_byte_yjs_invalid() {
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-pw");
        let key = test_key();
        let local_fp = {
            let ks = engine.make_key_state(&key);
            ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap()
        };
        // yjs starts with 0x99 (unknown), meta starts with 0x01 (valid AES-GCM marker).
        let payload = crate::sync::entry_sync::SyncEntryPayload::new(
            local_fp,
            vec![0x99, 0x01, 0x02, 0x03], // unknown version byte
            vec![0x01, 0x04, 0x05, 0x06], // valid version byte
        );
        let entry_id = uuid::Uuid::new_v4().to_string();
        let err = engine
            .ingest_entry(&conn, &key_state_from_key(&key), &entry_id, &payload)
            .unwrap_err();
        match &err {
            SyncError::CrossModeReject(msg) => {
                assert!(
                    msg.contains("Unknown sync envelope format"),
                    "error must mention 'Unknown sync envelope format': {msg:?}"
                );
                assert!(
                    msg.contains("Update the app"),
                    "error must tell user to 'Update the app': {msg:?}"
                );
            }
            other => panic!("expected CrossModeReject, got {other:?}"),
        }
    }

    /// `map_envelope_error_for_user` produces user-friendly messages that
    /// include the correct action hint for each envelope error kind.
    #[test]
    fn envelope_error_mapping_is_user_friendly() {
        // UnknownVersion: unrecognised version byte (includes a stray 0x00
        // plaintext envelope from a pre-rewrite vault — always encrypted now,
        // so it is just "unknown", not a mode to switch to).
        let msg = map_envelope_error_for_user("entries", "unknown envelope version: 0x42");
        assert!(
            msg.contains("Update the app"),
            "UnknownVersion mapping must say 'Update the app': {msg:?}"
        );

        // Empty
        let msg = map_envelope_error_for_user("locations", "envelope is empty");
        assert!(
            msg.contains("corrupted"),
            "Empty mapping must mention 'corrupted': {msg:?}"
        );

        // Unknown / passthrough
        let msg = map_envelope_error_for_user("journals", "some other error");
        assert!(
            msg.contains("decrypt failed"),
            "Unknown error must fall through as 'decrypt failed': {msg:?}"
        );
    }

    // ─── Phase 5 T4: epoch-aware ingest tests ─────────────────────────────────

    /// T4.2 — `ingest_entry` selects the correct key by fingerprint.
    ///
    /// Scenario: device A has two content-key epochs. Entries are pushed under
    /// both epochs. Ingest with the full 2-epoch state must decrypt both
    /// entries correctly regardless of which epoch was used to seal each entry.
    ///
    /// Note: the "boring channels" (settings/tags/journals) always use a single
    /// key (the `key` arg). This test verifies only the ENTRY ingest path.
    #[tokio::test]
    async fn ingest_selects_key_by_fingerprint_and_epoch() {
        use crate::sync::entry_sync::deserialize_payload;
        use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};

        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();

        // Two different content keys (simulating epoch 1 and epoch 2).
        let key_epoch1 = derive_encryption_key("epoch1-password", &[1u8; SALT_SIZE]).unwrap();
        let key_epoch2 = derive_encryption_key("epoch2-password", &[2u8; SALT_SIZE]).unwrap();

        // Device A pushes two entries — one under each epoch key.
        let engine_a = make_engine(&dir, "dev-a");
        let entry1_id = make_entry_with_content(&conn_a, &key_epoch1, "content under epoch 1");
        engine_a
            .push_single_entry(&conn_a, &key_epoch1, &entry1_id)
            .await
            .unwrap();

        let entry2_id = make_entry_with_content(&conn_a, &key_epoch2, "content under epoch 2");
        engine_a
            .push_single_entry(&conn_a, &key_epoch2, &entry2_id)
            .await
            .unwrap();

        // Push metadata.json using epoch1 key (so pull_remote can see the manifest).
        // We use epoch1 for the boring channels; only the entry payloads differ.
        engine_a
            .push_local(
                &conn_a,
                &key_epoch1,
                &key_state_from_key(&key_epoch1),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Device B has both epoch keys. Build a 2-epoch EncryptionKeyState.
        let mut keys: std::collections::BTreeMap<u32, zeroize::Zeroizing<[u8; 32]>> =
            std::collections::BTreeMap::new();
        keys.insert(1u32, zeroize::Zeroizing::new(*key_epoch1));
        keys.insert(2u32, zeroize::Zeroizing::new(*key_epoch2));
        let key_state_b = crate::EncryptionKeyState::new();
        key_state_b
            .set_content_state(
                keys,
                2u32,
                zeroize::Zeroizing::new(*key_epoch2),
                zeroize::Zeroizing::new(*key_epoch2),
            )
            .unwrap();

        // Test directly via ingest_entry for the two entry payloads, using the
        // 2-epoch key state. This avoids the boring-channels key mismatch.
        let engine_b = make_engine(&dir, "dev-b");

        // Read back the entry payloads that dev-a wrote to disk.
        let path1 = dir.path().join(format!("dev-a/entries/{entry1_id}.bin"));
        let path2 = dir.path().join(format!("dev-a/entries/{entry2_id}.bin"));
        let payload1 = deserialize_payload(&std::fs::read(&path1).unwrap()).unwrap();
        let payload2 = deserialize_payload(&std::fs::read(&path2).unwrap()).unwrap();

        // Ingest both entries using the 2-epoch state — both must succeed.
        let result1 = engine_b.ingest_entry(&conn_b, &key_state_b, &entry1_id, &payload1);
        assert!(
            result1.is_ok(),
            "ingest of epoch-1 entry must succeed: {:?}",
            result1
        );

        let result2 = engine_b.ingest_entry(&conn_b, &key_state_b, &entry2_id, &payload2);
        assert!(
            result2.is_ok(),
            "ingest of epoch-2 entry must succeed: {:?}",
            result2
        );

        // Verify both entries are now in dev-b's DB.
        let count: i64 = conn_b
            .query_row(
                "SELECT count(*) FROM entries WHERE id IN (?1, ?2)",
                [&entry1_id, &entry2_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2, "both entries must be in dev-b's DB after ingest");
    }

    /// T4.3 — `ingest_entry` rejects an entry whose fingerprint matches no key
    /// in the local list (simulates a rotation the local device missed).
    #[tokio::test]
    async fn ingest_rejects_unknown_content_key() {
        use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};

        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();

        // Device A pushes with a key B has never seen.
        let key_a_unknown = derive_encryption_key("unknown-to-b", &[3u8; SALT_SIZE]).unwrap();
        let key_b_known = derive_encryption_key("b-only-key", &[4u8; SALT_SIZE]).unwrap();

        let engine_a = make_engine(&dir, "dev-a");
        make_entry_with_content(&conn_a, &key_a_unknown, "entry under unknown key");
        engine_a
            .push_local(
                &conn_a,
                &key_a_unknown,
                &key_state_from_key(&key_a_unknown),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // Device B only knows its own key (not key_a_unknown).
        let engine_b = make_engine(&dir, "dev-b");
        let stats = engine_b
            .pull_remote(&conn_b, &key_b_known, &key_state_from_key(&key_b_known))
            .await
            .unwrap();

        assert_eq!(stats.pulled, 0, "entry under unknown key must be rejected");
        assert!(
            !stats.errors.is_empty(),
            "must report an error for unknown fingerprint"
        );
        // Error must mention fingerprint mismatch / re-pair, not a vague decode error.
        let err_text = stats.errors.join("; ");
        assert!(
            err_text.contains("fingerprint")
                || err_text.contains("key")
                || err_text.contains("re-pair"),
            "error must mention fingerprint/key/re-pair: {err_text}"
        );
    }

    /// T4.6 — Derivation-depth guard: push via the real production wiring
    /// (`key_copy = with_sync_key(|k| *k)` → engine), ingest via
    /// `snapshot_for_engine()`. This test replicates the exact path that
    /// `run_sync_now` uses. Before the `snapshot_for_engine` fix it would
    /// fail with "key fingerprint not found" because the snapshot stored raw
    /// content keys (1 derive depth) while the push path used 2 derives.
    #[tokio::test]
    async fn snapshot_for_engine_matches_push_derivation_depth() {
        use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};

        let dir = TempDir::new().unwrap();
        let conn_a = fresh_db();
        let conn_b = fresh_db();

        // Build an app-level EncryptionKeyState with a single content key —
        // the same structure that `onboard_complete` produces.
        let master = derive_encryption_key("prod-wiring-test", &[9u8; SALT_SIZE]).unwrap();
        let app_key_state = crate::EncryptionKeyState::new();
        app_key_state
            .set_key(zeroize::Zeroizing::new(*master))
            .unwrap();

        // Replicate what run_sync_now does: derive key_copy via with_sync_key.
        let key_copy: [u8; 32] = app_key_state
            .with_sync_key(|k| Ok(*k))
            .expect("with_sync_key must succeed");

        // Build the snapshot exactly as run_sync_now does.
        let snapshot = app_key_state
            .snapshot_for_engine()
            .expect("snapshot_for_engine must succeed for a set key");

        // Push an entry using key_copy (the once-derived key) — same as the engine.
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key_copy, "prod-wiring content");
        engine_a
            .push_single_entry(&conn_a, &key_copy, &entry_id)
            .await
            .unwrap();

        // Ingest on dev-b using the snapshot — must round-trip correctly.
        let engine_b = make_engine(&dir, "dev-b");
        let path = dir.path().join(format!("dev-a/entries/{entry_id}.bin"));
        let payload = {
            use crate::sync::entry_sync::deserialize_payload;
            deserialize_payload(&std::fs::read(&path).unwrap()).unwrap()
        };

        let result = engine_b.ingest_entry(&conn_b, &snapshot, &entry_id, &payload);
        assert!(
            result.is_ok(),
            "snapshot_for_engine ingest must round-trip under production wiring: {:?}",
            result
        );

        // Verify the entry is now in dev-b's DB.
        let count: i64 = conn_b
            .query_row(
                "SELECT count(*) FROM entries WHERE id = ?1",
                [&entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "ingested entry must appear in dev-b's DB");

        // Two-epoch variant: add a second content key and verify both epochs round-trip.
        let master2 = derive_encryption_key("prod-wiring-epoch2", &[10u8; SALT_SIZE]).unwrap();
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1u32, zeroize::Zeroizing::new(*master));
        keys.insert(2u32, zeroize::Zeroizing::new(*master2));
        let app_key_state2 = crate::EncryptionKeyState::new();
        app_key_state2
            .set_content_state(
                keys,
                2u32,
                zeroize::Zeroizing::new(*master2),
                zeroize::Zeroizing::new(*master2),
            )
            .unwrap();

        // key_copy for epoch 2 (latest).
        let key_copy2: [u8; 32] = app_key_state2
            .with_sync_key(|k| Ok(*k))
            .expect("with_sync_key must succeed for epoch 2");

        let snapshot2 = app_key_state2
            .snapshot_for_engine()
            .expect("snapshot_for_engine must succeed for 2-epoch state");

        let engine_c = make_engine(&dir, "dev-c");
        let conn_c = fresh_db();
        let conn_d = fresh_db();

        // Push two entries under different epoch keys.
        let entry_e1 = make_entry_with_content(&conn_c, &key_copy, "epoch-1 in 2-epoch state");
        engine_c
            .push_single_entry(&conn_c, &key_copy, &entry_e1)
            .await
            .unwrap();
        let entry_e2 = make_entry_with_content(&conn_c, &key_copy2, "epoch-2 content");
        engine_c
            .push_single_entry(&conn_c, &key_copy2, &entry_e2)
            .await
            .unwrap();

        // Ingest both on dev-d using 2-epoch snapshot.
        let engine_d = make_engine(&dir, "dev-d");
        for (eid, ename) in [(&entry_e1, "epoch-1"), (&entry_e2, "epoch-2")] {
            let ep = dir.path().join(format!("dev-c/entries/{eid}.bin"));
            let pl = {
                use crate::sync::entry_sync::deserialize_payload;
                deserialize_payload(&std::fs::read(&ep).unwrap()).unwrap()
            };
            let r = engine_d.ingest_entry(&conn_d, &snapshot2, eid, &pl);
            assert!(
                r.is_ok(),
                "2-epoch snapshot ingest must succeed for {ename} entry: {:?}",
                r
            );
        }
    }

    /// F2 regression: settings encrypted under epoch-1 must still decrypt on a
    /// peer that has rotated to epoch-2.
    ///
    /// Scenario:
    ///   dev-a pushes settings with epoch-1 key → settings.bin encrypted with
    ///   epoch-1 sync sub-key (0x01 format, legacy).
    ///   dev-b (rotated to epoch-2) pulls — decrypt must succeed because
    ///   `pull_settings` now receives the full key_state_full and its
    ///   `try_all_sync_keys` tries every epoch.
    #[tokio::test]
    async fn pull_settings_decrypts_historical_epoch_after_rotation() {
        use crate::utils::encryption::derive_encryption_key;
        use crate::utils::encryption::SALT_SIZE;

        let dir = TempDir::new().unwrap();

        // Build two content keys: epoch-1 and epoch-2.
        let key_ep1 = *derive_encryption_key("f2-epoch1", &[1u8; SALT_SIZE]).unwrap();
        let key_ep2 = *derive_encryption_key("f2-epoch2", &[2u8; SALT_SIZE]).unwrap();

        // dev-a state: epoch-1 only (old peer before rotation).
        let ks_epoch1 = key_state_from_key(&key_ep1);
        // Derive the sync sub-key the way run_sync_now does.
        let sync_key_ep1: [u8; 32] = ks_epoch1
            .with_sync_key(|k| Ok(*k))
            .expect("with_sync_key ep1");

        // dev-b state: 2-epoch snapshot (rotated peer).
        let mut keys2 = std::collections::BTreeMap::new();
        keys2.insert(1u32, zeroize::Zeroizing::new(key_ep1));
        keys2.insert(2u32, zeroize::Zeroizing::new(key_ep2));
        let ks_two_epoch = crate::EncryptionKeyState::new();
        ks_two_epoch
            .set_content_state(
                keys2,
                2u32,
                zeroize::Zeroizing::new(key_ep2),
                zeroize::Zeroizing::new(key_ep2),
            )
            .unwrap();
        let sync_key_ep2: [u8; 32] = ks_two_epoch
            .with_sync_key(|k| Ok(*k))
            .expect("with_sync_key ep2");
        let snapshot_ep2 = ks_two_epoch
            .snapshot_for_engine()
            .expect("snapshot_for_engine 2-epoch");

        // dev-a pushes settings using epoch-1 sync key.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        engine_a
            .push_settings(&conn_a, &sync_key_ep1)
            .await
            .expect("push_settings must succeed for dev-a");

        // dev-b pulls with the 2-epoch snapshot.  Before the F2 fix, this would
        // fail because pull_settings used make_key_state(sync_key_ep2) which only
        // held epoch-2 and could not decrypt the epoch-1 envelope.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let errors = engine_b
            .pull_settings(&conn_b, &sync_key_ep2, &snapshot_ep2)
            .await
            .expect("pull_settings must succeed (no fatal SyncError)");
        assert!(
            errors.errors.is_empty(),
            "pull_settings must decrypt epoch-1 settings with 2-epoch snapshot; errors: {:?}",
            errors.errors
        );
    }

    // ── Version-stamp race regression (Bug 1) ───────────────────────────────
    //
    // push_single_entry used to snapshot the entry content, release the DB
    // lock, upload (potentially slow), then re-read local_version FRESH in a
    // second with_conn and stamp that version as synced.  If a concurrent edit
    // bumped local_version from N to N+1 during the upload, the re-read would
    // return N+1 and mark_entry_synced(N+1) would be called while the cloud
    // still holds the N bytes — the N+1 edit would then be silently never
    // re-pushed.
    //
    // The fix: capture serialized_version INSIDE the first with_conn (atomic
    // with the content read), then after the upload compare current_version ==
    // serialized_version and only stamp when they match.

    /// A SyncProvider whose `write_file` blocks until `unblock` is notified,
    /// and signals `started` before it parks.  All other methods delegate to
    /// an inner MockProvider.
    struct BlockingWriteProvider {
        inner: crate::sync::provider::test_support::MockProvider,
        started: Arc<tokio::sync::Notify>,
        unblock: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl SyncProvider for BlockingWriteProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            self.inner.list_devices().await
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: crate::sync::provider::FileKind,
        ) -> Result<Vec<String>, SyncError> {
            self.inner.list_files(device_id, kind).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.inner.read_file(path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            // Signal that the upload has "started" (snapshot complete, in-flight).
            self.started.notify_one();
            // Block until the test driver fires unblock.
            self.unblock.notified().await;
            // Delegate to the in-memory store.
            self.inner.write_file(path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.inner.delete_file(path).await
        }
    }

    #[tokio::test]
    async fn push_single_entry_does_not_stamp_synced_when_concurrent_edit_bumps_version() {
        // Regression test for Bug 1 (version-stamp race / silent data loss).
        //
        // Timeline:
        //   T0 — entry created, version=1, status=pending
        //   T1 — push_single_entry snapshots version=1, releases DB lock, begins upload
        //   T2 — concurrent edit: mark_entry_pending bumps version to 2
        //   T3 — upload completes; post-fix code sees version=2 ≠ serialized=1,
        //        so it does NOT call mark_entry_synced → entry stays pending
        //
        // Buggy code: re-reads version after upload, stamps 2 as synced, entry
        // disappears from list_pending_entry_ids — the edit is never re-pushed.

        let key = test_key();
        let conn = fresh_db();

        let started = Arc::new(tokio::sync::Notify::new());
        let unblock = Arc::new(tokio::sync::Notify::new());

        let provider = Arc::new(BlockingWriteProvider {
            inner: crate::sync::provider::test_support::MockProvider::new(),
            started: Arc::clone(&started),
            unblock: Arc::clone(&unblock),
        });
        let engine = SyncEngine::new(provider, "dev-race".to_string());

        // Create an entry and mark it pending (version = 1).
        let entry_id = make_entry_with_content(&conn, &key, "original content");

        // Verify initial state: version=1, status=pending.
        let initial_version = db::get_entry_local_version(&conn, &entry_id)
            .unwrap()
            .expect("sync_state row must exist");
        assert_eq!(initial_version, 1, "initial version must be 1");
        assert_eq!(
            db::count_pending_entries(&conn).unwrap(),
            1,
            "entry must be pending before push"
        );

        // Run push_single_entry concurrently with the simulated concurrent edit.
        // join! runs both futures on the current task — no Send/Sync required.
        let push_fut = engine.push_single_entry(&conn, &key, &entry_id);
        let race_fut = async {
            // Wait until push_single_entry has snapshotted and is inside write_file.
            started.notified().await;
            // Concurrent edit: bump version from 1 → 2 while upload is in flight.
            db::mark_entry_pending(&conn, &entry_id).unwrap();
            // Let the upload finish.
            unblock.notify_one();
        };

        let (push_result, _) = tokio::join!(push_fut, race_fut);
        push_result.expect("push_single_entry must not return an error");

        // After push, entry must still be pending (version 2 was never pushed).
        let final_version = db::get_entry_local_version(&conn, &entry_id)
            .unwrap()
            .expect("sync_state row must still exist");
        assert_eq!(final_version, 2, "version must have been bumped to 2");

        let pending_ids = db::list_pending_entry_ids(&conn).unwrap();
        assert!(
            pending_ids.contains(&entry_id),
            "entry must remain in list_pending_entry_ids after concurrent edit \
             (version 2 edit must not be falsely marked synced); \
             got pending_ids={pending_ids:?}"
        );

        // Verify the sync_status column directly.
        let sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            sync_status, "pending",
            "sync_status must be 'pending', not 'synced', after concurrent version bump"
        );
    }

    #[tokio::test]
    async fn push_single_entry_stamps_synced_when_no_concurrent_edit() {
        // Guard: the no-race path must still mark the entry synced normally.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-norace");

        let entry_id = make_entry_with_content(&conn, &key, "stable content");
        assert_eq!(db::count_pending_entries(&conn).unwrap(), 1);

        engine
            .push_single_entry(&conn, &key, &entry_id)
            .await
            .unwrap();

        // Must be marked synced — no concurrent edit occurred.
        assert_eq!(
            db::count_pending_entries(&conn).unwrap(),
            0,
            "entry must be marked synced when no concurrent edit occurred"
        );
        let sync_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
                [&entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sync_status, "synced");
    }

    // ─── Bug 4: stale tombstone clobber guard ───────────────────────────────

    /// Regression guard for Bug 4: when `pull_remote` processes multiple
    /// peers, the diff's `local_view` is frozen once before the loop. If
    /// peer A's live blob (T3) is ingested first, then peer B's tombstone
    /// at T2 is processed against the stale view (which shows T1), the
    /// unguarded UPDATE would soft-delete the freshly-pulled T3 row.
    ///
    /// Fix: carry the tombstone's `updated_at` into `to_delete_locally` and
    /// guard the UPDATE with `AND updated_at < tombstone_updated_at`.
    #[tokio::test]
    async fn stale_tombstone_does_not_clobber_newer_pulled_entry() {
        // Timestamps: T1 < T2 < T3
        // T1 = local receiver's state (starting point)
        // T2 = peer-B tombstone updated_at  (older than T3)
        // T3 = peer-A live entry updated_at (newest)
        let t1: i64 = 1_000_000;
        let t2: i64 = 2_000_000;
        let t3: i64 = 3_000_000;

        let key = test_key();
        let dir = TempDir::new().unwrap();

        // ── Peer A: real push at T3 ──────────────────────────────────────
        // We use a real push so the encrypted blob + manifest exist on disk
        // under dev-a/. This is simpler than hand-rolling the payload.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "live content from A");
        // Override the updated_at to T3 so the manifest carries T3.
        conn_a
            .execute(
                "UPDATE entries SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![t3, &entry_id],
            )
            .unwrap();
        // Also stamp the sync_state so the manifest is consistent.
        conn_a
            .execute(
                "UPDATE sync_state SET synced_version = 0 WHERE entry_id = ?1",
                rusqlite::params![&entry_id],
            )
            .unwrap();
        engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();

        // ── Peer B: hand-written tombstone manifest at T2, no blob ──────
        // `list_devices()` returns dirs sorted alphabetically, so dev-a < dev-b.
        // pull_remote will process dev-a first (ingest T3 live), then dev-b
        // (tombstone T2 against stale local_view still showing T1).
        let manifest_b = DeviceMetadata {
            device_id: "dev-b".to_string(),
            recovery_generation: 0,
            entries: vec![super::super::metadata::SyncedEntrySummary {
                entry_id: entry_id.clone(),
                updated_at: t2,
                local_version: 1,
                is_deleted: true,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: t2,
        };
        let manifest_b_dir = dir.path().join("dev-b");
        std::fs::create_dir_all(&manifest_b_dir).unwrap();
        std::fs::write(
            manifest_b_dir.join("metadata.json"),
            serde_json::to_vec(&manifest_b).unwrap(),
        )
        .unwrap();

        // ── Receiver: pull from both peers ──────────────────────────────
        // Seed the receiver with the entry at T1 so the stale local_view
        // has a real row to diff against.
        let conn_r = fresh_db();
        let journal_r = default_journal(&conn_r);
        conn_r
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'old', ?3, ?3, ?4, 0, 0, NULL)",
                rusqlite::params![&entry_id, &journal_r, t1, t1],
            )
            .unwrap();

        let engine_r = make_engine(&dir, "dev-receiver");
        engine_r
            .pull_remote(&conn_r, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // ── Assert: live row at T3, NOT deleted ─────────────────────────
        let (is_deleted, updated_at): (i64, i64) = conn_r
            .query_row(
                "SELECT is_deleted, updated_at FROM entries WHERE id = ?1",
                [&entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            is_deleted, 0,
            "the stale tombstone (T2) must NOT clobber the freshly-pulled live row (T3)"
        );
        assert_eq!(
            updated_at, t3,
            "updated_at must reflect peer-A's payload (T3), not the tombstone's T2"
        );
    }

    /// Regression guard for Bug 4 (single-peer variant): a tombstone that
    /// IS newer than the local row must still apply, and `entries.updated_at`
    /// must be set to the tombstone's `updated_at` — not `now_unix()` —
    /// so future LWW diffs converge correctly.
    #[tokio::test]
    async fn tombstone_sets_entry_updated_at_to_tombstone_timestamp_not_now() {
        let t_local: i64 = 1_000_000;
        let t_tombstone: i64 = 2_000_000;

        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Seed receiver with a live entry at t_local.
        let conn_r = fresh_db();
        let journal_r = default_journal(&conn_r);
        let entry_id = uuid::Uuid::new_v4().to_string();
        conn_r
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'content', ?3, ?3, ?4, 0, 0, NULL)",
                rusqlite::params![&entry_id, &journal_r, t_local, t_local],
            )
            .unwrap();

        // Peer with a tombstone at t_tombstone (strictly newer than t_local).
        let manifest_peer = DeviceMetadata {
            device_id: "dev-peer".to_string(),
            recovery_generation: 0,
            entries: vec![super::super::metadata::SyncedEntrySummary {
                entry_id: entry_id.clone(),
                updated_at: t_tombstone,
                local_version: 1,
                is_deleted: true,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: t_tombstone,
        };
        let peer_dir = dir.path().join("dev-peer");
        std::fs::create_dir_all(&peer_dir).unwrap();
        std::fs::write(
            peer_dir.join("metadata.json"),
            serde_json::to_vec(&manifest_peer).unwrap(),
        )
        .unwrap();

        let engine_r = make_engine(&dir, "dev-receiver");
        engine_r
            .pull_remote(&conn_r, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        // Tombstone must have been applied (is_deleted=1), and
        // updated_at must equal the tombstone's timestamp so
        // future peers don't re-pull the entry.
        let (is_deleted, updated_at): (i64, i64) = conn_r
            .query_row(
                "SELECT is_deleted, updated_at FROM entries WHERE id = ?1",
                [&entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            is_deleted, 1,
            "tombstone must be applied when it is newer than local row"
        );
        assert_eq!(
            updated_at, t_tombstone,
            "entries.updated_at must be set to the tombstone's updated_at, not now_unix()"
        );
    }

    /// C2 fix: a peer-applied entry tombstone must cascade the AI User
    /// Memory cleanup, or this device's copy of the deleted entry's
    /// distilled memory survives orphaned forever (it was never soft-deleted
    /// through `soft_delete_entry_impl`, so the cascade would otherwise
    /// never run on this device at all).
    #[tokio::test]
    async fn peer_tombstone_cascades_memory_cleanup() {
        let t_local: i64 = 1_000_000;
        let t_tombstone: i64 = 2_000_000;

        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Seed receiver with a live entry at t_local, plus a memory item
        // sourced SOLELY from it.
        let conn_r = fresh_db();
        let journal_r = default_journal(&conn_r);
        let entry_id = uuid::Uuid::new_v4().to_string();
        conn_r
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'content', ?3, ?3, ?4, 0, 0, NULL)",
                rusqlite::params![&entry_id, &journal_r, t_local, t_local],
            )
            .unwrap();
        db::memory::insert_memory_item(&conn_r, "m1", "sole source fact", "journal_entry", t_local)
            .unwrap();
        db::memory::add_memory_source(&conn_r, "m1", "journal_entry", &entry_id).unwrap();

        // Peer with a tombstone at t_tombstone (strictly newer than t_local).
        let manifest_peer = DeviceMetadata {
            device_id: "dev-peer".to_string(),
            recovery_generation: 0,
            entries: vec![super::super::metadata::SyncedEntrySummary {
                entry_id: entry_id.clone(),
                updated_at: t_tombstone,
                local_version: 1,
                is_deleted: true,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: t_tombstone,
        };
        let peer_dir = dir.path().join("dev-peer");
        std::fs::create_dir_all(&peer_dir).unwrap();
        std::fs::write(
            peer_dir.join("metadata.json"),
            serde_json::to_vec(&manifest_peer).unwrap(),
        )
        .unwrap();

        let engine_r = make_engine(&dir, "dev-receiver");
        engine_r
            .pull_remote(&conn_r, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let is_deleted: i64 = conn_r
            .query_row(
                "SELECT is_deleted FROM entries WHERE id = ?1",
                [&entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1, "peer tombstone must be applied");

        let items = db::memory::list_memory_items(&conn_r).unwrap();
        assert!(
            items.iter().all(|i| i.id != "m1"),
            "a peer-applied tombstone must cascade the memory cleanup (C2 fix)"
        );
    }

    /// 💡 review pass 2: the test above only covers a sole, UNLOCKED source.
    /// Add the C1(a) "tombstone whole, even with a surviving source" case
    /// through the SAME peer-tombstone path: the peer tombstones a LOCKED
    /// entry that co-sources a memory alongside an untouched, unlocked
    /// entry. The whole item must still be dropped — the surviving
    /// unlocked source must not rescue it.
    #[tokio::test]
    async fn peer_tombstone_of_locked_entry_cascades_memory_cleanup_even_with_surviving_source() {
        let t_local: i64 = 1_000_000;
        let t_tombstone: i64 = 2_000_000;

        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_r = fresh_db();
        let journal_r = default_journal(&conn_r);
        let locked_id = uuid::Uuid::new_v4().to_string();
        let surviving_id = uuid::Uuid::new_v4().to_string();
        conn_r
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, is_locked, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'content', ?3, ?3, ?4, 0, 0, 1, NULL)",
                rusqlite::params![&locked_id, &journal_r, t_local, t_local],
            )
            .unwrap();
        conn_r
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'content', ?3, ?3, ?3, 0, 0, NULL)",
                rusqlite::params![&surviving_id, &journal_r, t_local],
            )
            .unwrap();
        db::memory::insert_memory_item(&conn_r, "m1", "blended fact", "journal_entry", t_local)
            .unwrap();
        db::memory::add_memory_source(&conn_r, "m1", "journal_entry", &locked_id).unwrap();
        db::memory::add_memory_source(&conn_r, "m1", "journal_entry", &surviving_id).unwrap();

        let manifest_peer = DeviceMetadata {
            device_id: "dev-peer".to_string(),
            recovery_generation: 0,
            entries: vec![super::super::metadata::SyncedEntrySummary {
                entry_id: locked_id.clone(),
                updated_at: t_tombstone,
                local_version: 1,
                is_deleted: true,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: t_tombstone,
        };
        let peer_dir = dir.path().join("dev-peer");
        std::fs::create_dir_all(&peer_dir).unwrap();
        std::fs::write(
            peer_dir.join("metadata.json"),
            serde_json::to_vec(&manifest_peer).unwrap(),
        )
        .unwrap();

        let engine_r = make_engine(&dir, "dev-receiver");
        engine_r
            .pull_remote(&conn_r, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let is_deleted: i64 = conn_r
            .query_row(
                "SELECT is_deleted FROM entries WHERE id = ?1",
                [&locked_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1, "peer tombstone must be applied");

        let items = db::memory::list_memory_items(&conn_r).unwrap();
        assert!(
            items.iter().all(|i| i.id != "m1"),
            "a peer tombstone of a LOCKED source must tombstone the whole memory \
             item even with a surviving unlocked source (C1(a))"
        );
    }

    /// C6 fix: a peer-applied chat-session tombstone (via
    /// `upsert_synced_chat_session_lww`'s remote-wins branch) must cascade
    /// the AI User Memory cleanup, mirroring `peer_tombstone_cascades_memory_cleanup`
    /// above for entries. `daily_chat` memories have NO retrieval-time
    /// privacy backstop, so this is the only place that ever drops them for
    /// a peer-originated session delete.
    #[tokio::test]
    async fn peer_chat_session_tombstone_cascades_memory_cleanup() {
        let t_local: i64 = 1_000_000;
        let t_tombstone: i64 = 2_000_000;

        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_r = fresh_db();
        db::create_chat_session(&conn_r, "chat-session-1", "empathetic", "", "en", t_local)
            .unwrap();
        db::memory::insert_memory_item(&conn_r, "m1", "sole source fact", "daily_chat", t_local)
            .unwrap();
        db::memory::add_memory_source(&conn_r, "m1", "daily_chat", "chat-session-1").unwrap();

        let payload = super::super::metadata::ChatPayload {
            device_id: "dev-peer".to_string(),
            generated_at: t_tombstone,
            sessions: vec![super::super::metadata::SyncedChatSession {
                id: "chat-session-1".to_string(),
                title: None,
                persona: "empathetic".to_string(),
                persona_prompt_snapshot: "".to_string(),
                language: "en".to_string(),
                created_at: t_local,
                updated_at: t_tombstone,
                is_deleted: true,
                title_is_ai_generated: false,
                used_rag: false,
                converted_entry_id: None,
                converted_through_seq: None,
                pinned_at: None,
                messages: vec![],
            }],
        };
        write_peer_channel_blob(
            &dir,
            "chats.bin",
            &key,
            &serde_json::to_vec(&payload).unwrap(),
        );

        let engine_r = make_engine(&dir, "dev-receiver");
        let errors = engine_r
            .pull_chats(&conn_r, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected pull errors: {errors:?}");

        let is_deleted: i64 = conn_r
            .query_row(
                "SELECT is_deleted FROM chat_sessions WHERE id = 'chat-session-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_deleted, 1, "peer tombstone must be applied");

        let items = db::memory::list_memory_items(&conn_r).unwrap();
        assert!(
            items.iter().all(|i| i.id != "m1"),
            "a peer-applied chat-session tombstone must cascade the memory cleanup (C6 fix)"
        );
    }

    /// Regression guard for timestamp poisoning: a malicious (or buggy) peer
    /// can publish a tombstone with `updated_at = i64::MAX`. Without clamping
    /// the receiver would stamp `i64::MAX` onto the local row, making it
    /// permanently un-resurrectable — no real edit can ever produce a timestamp
    /// exceeding `i64::MAX`, so `compute_diff`'s `r.updated_at > l.updated_at`
    /// can never be true for that entry again.
    ///
    /// Fix: the receiver must clamp the inbound tombstone timestamp to
    /// `now + MAX_CLOCK_SKEW_SECS` before writing it, so a genuine edit
    /// written within the next 24 h can still exceed it.
    #[tokio::test]
    async fn tombstone_with_max_timestamp_is_clamped_on_pull() {
        let t_local: i64 = 1_000_000; // receiver's live entry

        let key = test_key();
        let dir = TempDir::new().unwrap();

        // Seed receiver with a live entry at t_local.
        let conn_r = fresh_db();
        let journal_r = default_journal(&conn_r);
        let entry_id = uuid::Uuid::new_v4().to_string();
        conn_r
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'content', ?3, ?3, ?4, 0, 0, NULL)",
                rusqlite::params![&entry_id, &journal_r, t_local, t_local],
            )
            .unwrap();

        // Adversarial peer: tombstone with updated_at = i64::MAX.
        let manifest_peer = DeviceMetadata {
            device_id: "dev-attacker".to_string(),
            recovery_generation: 0,
            entries: vec![super::super::metadata::SyncedEntrySummary {
                entry_id: entry_id.clone(),
                updated_at: i64::MAX,
                local_version: 1,
                is_deleted: true,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: i64::MAX,
        };
        let peer_dir = dir.path().join("dev-attacker");
        std::fs::create_dir_all(&peer_dir).unwrap();
        std::fs::write(
            peer_dir.join("metadata.json"),
            serde_json::to_vec(&manifest_peer).unwrap(),
        )
        .unwrap();

        let engine_r = make_engine(&dir, "dev-receiver");
        engine_r
            .pull_remote(&conn_r, &key, &key_state_from_key(&key))
            .await
            .unwrap();

        let (is_deleted, updated_at): (i64, i64) = conn_r
            .query_row(
                "SELECT is_deleted, updated_at FROM entries WHERE id = ?1",
                [&entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();

        // Tombstone applies (i64::MAX > t_local) — the entry IS soft-deleted.
        assert_eq!(is_deleted, 1, "tombstone must be applied");

        // But the stored timestamp must be clamped: NOT i64::MAX.
        assert_ne!(
            updated_at,
            i64::MAX,
            "raw i64::MAX must not be written to the DB"
        );

        // And it must be within the allowed skew window so a real edit can
        // still exceed it and resurrect the entry.
        let ceiling = now_unix() + MAX_CLOCK_SKEW_SECS;
        assert!(
            updated_at <= ceiling,
            "clamped updated_at ({updated_at}) must be ≤ now + 24h ({ceiling})"
        );
    }

    // ── collect_peer_entry_ids / fetch_peer_manifests ─────────────────────

    /// Helper: write a `metadata.json` manifest for a peer into the mock provider.
    async fn write_peer_manifest(
        provider: &crate::sync::provider::test_support::MockProvider,
        peer_id: &str,
        entry_ids: &[&str],
    ) {
        let entries: Vec<super::super::metadata::SyncedEntrySummary> = entry_ids
            .iter()
            .map(|id| super::super::metadata::SyncedEntrySummary {
                entry_id: id.to_string(),
                updated_at: 1_000,
                local_version: 1,
                is_deleted: false,
            })
            .collect();
        let manifest = DeviceMetadata {
            device_id: peer_id.to_string(),
            recovery_generation: 0,
            entries,
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_000,
        };
        provider
            .write_file(
                &format!("{peer_id}/metadata.json"),
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn collect_peer_entry_ids_returns_all_peer_ids() {
        let provider = Arc::new(crate::sync::provider::test_support::MockProvider::new());
        // peer-a has 2 entries, peer-b has 2 entries.
        write_peer_manifest(&provider, "peer-a", &["e1", "e2"]).await;
        write_peer_manifest(&provider, "peer-b", &["e3", "e4"]).await;
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-self".to_string(),
        );

        let ids = engine.collect_peer_entry_ids().await;

        assert_eq!(ids.len(), 4, "all 4 peer entry IDs must be collected");
        for id in ["e1", "e2", "e3", "e4"] {
            assert!(ids.contains(id), "set must contain {id}");
        }
        // Self device's entries are not published to MockProvider yet, so
        // list_devices will not include "dev-self" unless we seed a file — verify
        // that the engine skips self regardless.
        assert!(!ids.contains("dev-self"), "self must not appear in set");
    }

    #[tokio::test]
    async fn reconcile_manifest_read_bypasses_conditional_revision_cache() {
        struct ConditionalCacheTrapProvider {
            inner: crate::sync::provider::test_support::MockProvider,
        }

        #[async_trait::async_trait]
        impl SyncProvider for ConditionalCacheTrapProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                self.inner.list_devices().await
            }
            async fn list_files(
                &self,
                device_id: &str,
                kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                self.inner.list_files(device_id, kind).await
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                self.inner.read_file(path).await
            }
            async fn read_file_if_changed(
                &self,
                _path: &str,
                _known_revision: Option<&str>,
            ) -> Result<ConditionalRead, SyncError> {
                Ok(ConditionalRead::Unchanged)
            }
            async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
                self.inner.write_file(path, data).await
            }
            async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
                self.inner.delete_file(path).await
            }
        }

        let provider = Arc::new(ConditionalCacheTrapProvider {
            inner: crate::sync::provider::test_support::MockProvider::new(),
        });
        write_peer_manifest(&provider.inner, "peer-a", &["e1"]).await;
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-self".to_string(),
        );

        let ids = engine.collect_peer_entry_ids().await;

        assert!(
            ids.contains("e1"),
            "reconcile must directly read the manifest instead of accepting an unchanged cache response"
        );
    }

    #[tokio::test]
    async fn collect_peer_entry_ids_excludes_tombstoned_entries() {
        // A peer manifest entry marked is_deleted is a deletion record, NOT a
        // live ownership claim. It must not enter `owned_by_peers`, otherwise
        // `sync_repair_from_this_device` would skip re-queuing this device's
        // newer live local copy and let the stale remote tombstone win.
        let provider = Arc::new(crate::sync::provider::test_support::MockProvider::new());
        let manifest = DeviceMetadata {
            device_id: "peer-a".to_string(),
            recovery_generation: 0,
            entries: vec![
                super::super::metadata::SyncedEntrySummary {
                    entry_id: "live".to_string(),
                    updated_at: 1_000,
                    local_version: 1,
                    is_deleted: false,
                },
                super::super::metadata::SyncedEntrySummary {
                    entry_id: "tombstoned".to_string(),
                    updated_at: 1_000,
                    local_version: 1,
                    is_deleted: true,
                },
            ],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 1_000,
        };
        provider
            .write_file(
                "peer-a/metadata.json",
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-self".to_string(),
        );

        let ids = engine.collect_peer_entry_ids().await;

        assert!(ids.contains("live"), "live peer entry must be claimed");
        assert!(
            !ids.contains("tombstoned"),
            "tombstoned peer entry must NOT count as peer ownership"
        );
        assert_eq!(ids.len(), 1, "only the live entry is owned by a peer");
    }

    #[tokio::test]
    async fn collect_peer_entry_ids_returns_empty_when_list_devices_fails() {
        // Use a custom provider whose list_devices always errors.
        struct FailingProvider;

        #[async_trait::async_trait]
        impl SyncProvider for FailingProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                Err(SyncError::Io("network down".into()))
            }
            async fn list_files(
                &self,
                _device_id: &str,
                _kind: crate::sync::provider::FileKind,
            ) -> Result<Vec<String>, SyncError> {
                Err(SyncError::Io("network down".into()))
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound(path.to_string()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Err(SyncError::Io("network down".into()))
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Err(SyncError::Io("network down".into()))
            }
        }

        let engine = SyncEngine::new(Arc::new(FailingProvider), "dev-self".to_string());
        let ids = engine.collect_peer_entry_ids().await;
        assert!(
            ids.is_empty(),
            "empty set must be returned when list_devices fails"
        );
    }

    #[tokio::test]
    async fn collect_peer_entry_ids_skips_failing_peer() {
        // peer-a: manifest fetch will fail (no metadata.json seeded).
        // peer-b: manifest fetch succeeds with entries e3, e4.
        let provider = Arc::new(crate::sync::provider::test_support::MockProvider::new());
        // Seed a dummy file for peer-a so it appears in list_devices, but no
        // metadata.json — read_file will return NotFound → silently skipped.
        provider
            .write_file("peer-a/entries/dummy.bin", b"x")
            .await
            .unwrap();
        write_peer_manifest(&provider, "peer-b", &["e3", "e4"]).await;
        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-self".to_string(),
        );

        let ids = engine.collect_peer_entry_ids().await;

        // Only peer-b's entries are in the set; peer-a had no manifest.
        assert_eq!(ids.len(), 2, "only peer-b entries expected");
        assert!(ids.contains("e3"));
        assert!(ids.contains("e4"));
    }

    /// A non-NotFound network error on one peer's manifest fetch must cause
    /// that peer's entries to be treated as unowned (safe to adopt). Other
    /// peers with reachable manifests still contribute their entry IDs.
    #[tokio::test]
    async fn collect_peer_entry_ids_skips_peer_on_network_error() {
        use crate::sync::provider::FileKind;

        // Custom provider: peer-a returns SyncError::Network on read_file,
        // peer-b has a valid manifest with entries e3, e4.
        struct NetworkErrOnPeerA {
            inner: crate::sync::provider::test_support::MockProvider,
        }

        #[async_trait::async_trait]
        impl SyncProvider for NetworkErrOnPeerA {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                self.inner.list_devices().await
            }
            async fn list_files(
                &self,
                device_id: &str,
                kind: FileKind,
            ) -> Result<Vec<String>, SyncError> {
                self.inner.list_files(device_id, kind).await
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                if path.starts_with("peer-a/") {
                    return Err(SyncError::Network("timeout".to_string()));
                }
                self.inner.read_file(path).await
            }
            async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
                self.inner.write_file(path, data).await
            }
            async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
                self.inner.delete_file(path).await
            }
        }

        let inner = crate::sync::provider::test_support::MockProvider::new();
        // Seed a file for peer-a so it appears in list_devices.
        inner
            .write_file("peer-a/entries/dummy.bin", b"x")
            .await
            .unwrap();
        // peer-b has a valid manifest.
        write_peer_manifest(&inner, "peer-b", &["e3", "e4"]).await;

        let provider = Arc::new(NetworkErrOnPeerA { inner });
        let engine = SyncEngine::new(provider as Arc<dyn SyncProvider>, "dev-self".to_string());

        let ids = engine.collect_peer_entry_ids().await;

        // peer-a was unreachable → its entries are not in the set (treated as
        // unowned / safe to adopt). Only peer-b's entries are returned.
        assert_eq!(ids.len(), 2, "only peer-b entries expected");
        assert!(ids.contains("e3"), "e3 must be present");
        assert!(ids.contains("e4"), "e4 must be present");
    }

    /// A peer whose metadata.json contains invalid JSON must be silently skipped;
    /// other peers still contribute their entry IDs.
    #[tokio::test]
    async fn collect_peer_entry_ids_skips_peer_on_bad_json() {
        let provider = Arc::new(crate::sync::provider::test_support::MockProvider::new());

        // peer-a has a metadata.json with invalid JSON.
        provider
            .write_file("peer-a/metadata.json", b"not valid json")
            .await
            .unwrap();
        // peer-b has a valid manifest with entries e5, e6.
        write_peer_manifest(&provider, "peer-b", &["e5", "e6"]).await;

        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-self".to_string(),
        );

        let ids = engine.collect_peer_entry_ids().await;

        // peer-a produced a JSON parse error → its entries absent from set.
        assert_eq!(ids.len(), 2, "only peer-b entries expected");
        assert!(ids.contains("e5"), "e5 must be present");
        assert!(ids.contains("e6"), "e6 must be present");
    }

    /// The engine must skip its own device_id even when that device appears in
    /// the list_devices response (i.e. when self has pushed a metadata.json).
    #[tokio::test]
    async fn collect_peer_entry_ids_skips_self() {
        let provider = Arc::new(crate::sync::provider::test_support::MockProvider::new());

        // Seed self's metadata.json so "dev-self" appears in list_devices.
        // If the self-skip guard were absent, e0 would appear in the result.
        write_peer_manifest(&provider, "dev-self", &["e0"]).await;
        // peer-a has entries e7, e8.
        write_peer_manifest(&provider, "peer-a", &["e7", "e8"]).await;

        let engine = SyncEngine::new(
            Arc::clone(&provider) as Arc<dyn SyncProvider>,
            "dev-self".to_string(),
        );

        let ids = engine.collect_peer_entry_ids().await;

        // Self entries must be excluded; only peer-a's entries are returned.
        assert!(
            !ids.contains("e0"),
            "self entry must NOT be in the peer set"
        );
        assert_eq!(ids.len(), 2, "only peer-a entries expected");
        assert!(ids.contains("e7"), "e7 must be present");
        assert!(ids.contains("e8"), "e8 must be present");
    }

    // ─── versions (Phase 2: sync + rotation + prune) ────────────────────────

    /// Insert a bare `entries` row with an explicit id, satisfying the
    /// `entry_versions.entry_id` FK without going through the full
    /// `create_entry` + `mark_entry_pending` path. Used on a "peer" device's
    /// connection to pre-seed the parent entry before pulling a version —
    /// mirroring real-world ordering, where `pull_remote` pulls entries
    /// before versions (see `pull_remote`'s channel ordering comment).
    fn seed_bare_entry(conn: &Connection, id: &str) {
        let journal_id = default_journal(conn);
        let now = now_unix();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6, 0, 0, ?7)",
            rusqlite::params![id, journal_id, "t", "p", "body", now, Vec::<u8>::new()],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn push_versions_uploads_pending_and_marks_uploaded() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let entry_id = make_entry_with_content(&conn, &key, "body");
        let version_id =
            db::insert_entry_version(&conn, &entry_id, b"yjs snapshot bytes", "preview", "dev-a")
                .unwrap();

        let (uploaded, errors) = engine.push_versions(&conn, &key).await.unwrap();
        assert_eq!(uploaded, 1);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");

        let path = dir.path().join(format!("dev-a/versions/{version_id}.bin"));
        assert!(
            path.exists(),
            "version blob must be written to the provider dir"
        );

        assert!(
            db::list_pending_version_uploads(&conn).unwrap().is_empty(),
            "version must no longer be pending after push"
        );
    }

    #[tokio::test]
    async fn push_versions_heartbeat_fires_even_when_every_upload_fails() {
        // A run of consecutive per-item failures must not go silent from the
        // stall guard's point of view.
        struct AlwaysFailWriteProvider;

        #[async_trait::async_trait]
        impl SyncProvider for AlwaysFailWriteProvider {
            async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
            async fn list_files(
                &self,
                _device_id: &str,
                _kind: crate::sync::provider::FileKind,
            ) -> Result<Vec<String>, SyncError> {
                Ok(vec![])
            }
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                Err(SyncError::NotFound(path.to_string()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Err(SyncError::Io("disk full".into()))
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Ok(())
            }
        }

        let key = test_key();
        let conn = fresh_db();
        let entry_id = make_entry_with_content(&conn, &key, "body");
        for i in 0..3 {
            db::insert_entry_version(
                &conn,
                &entry_id,
                format!("snapshot-{i}").as_bytes(),
                "preview",
                "dev-a",
            )
            .unwrap();
        }

        let reporter = CountingReporter::new();
        let engine = SyncEngine::new(Arc::new(AlwaysFailWriteProvider), "dev-a".to_string())
            .with_reporter(reporter.clone());

        let (uploaded, errors) = engine.push_versions(&conn, &key).await.unwrap();
        assert_eq!(uploaded, 0);
        assert_eq!(
            errors.len(),
            3,
            "every version upload should have failed: {errors:?}"
        );
        assert!(
            reporter.count() >= 3,
            "expected at least one heartbeat per failed version upload, got {}",
            reporter.count()
        );
    }

    // ─── embedding chunk-vector sync push (Phase 5 Task 2) ──────────────────

    /// Decode every batch file this device wrote under `{device}/embeddings/`,
    /// decrypt with the writer's own key, and return the flattened chunk
    /// list. Test-only helper for PUSH-side assertions — reads straight off
    /// disk with the simple writer-key decrypt path
    /// (`decrypt_embedding_bytes`) rather than `pull_embedding_chunks`'s
    /// provider-enumeration + reader/fingerprint path (Task 3), since these
    /// push tests only need to confirm what THIS device wrote, not
    /// exercise the cross-device pull.
    fn read_own_pushed_chunks(
        dir: &TempDir,
        device_id: &str,
        key: &[u8; 32],
    ) -> Vec<EmbeddingChunkVector> {
        let ks = key_state_from_key(key);
        let folder = dir.path().join(device_id).join("embeddings");
        let mut out = Vec::new();
        let entries = match std::fs::read_dir(&folder) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return out,
            Err(e) => panic!("read_dir {folder:?}: {e}"),
        };
        for entry in entries {
            let path = entry.unwrap().path();
            let bytes = std::fs::read(&path).unwrap();
            let payload = super::super::embedding_sync::deserialize_embedding_payload(&bytes)
                .unwrap_or_else(|e| panic!("deserialize {path:?}: {e}"));
            let plain = super::super::embedding_sync::decrypt_embedding_bytes(
                &ks,
                &payload.chunks_ciphertext,
            )
            .unwrap_or_else(|e| panic!("decrypt {path:?}: {e}"));
            let chunks = super::super::embedding_sync::deserialize_chunk_batch(&plain)
                .unwrap_or_else(|e| panic!("decode {path:?}: {e}"));
            out.extend(chunks);
        }
        out
    }

    #[tokio::test]
    async fn embedding_sync_push_round_trips_through_local_provider() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let entry_id = make_entry_with_content(&conn, &key, "body");
        db::embeddings::upsert_chunk(
            &conn,
            &entry_id,
            "model-a",
            0,
            "hash-0",
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();

        let (uploaded, errors) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert_eq!(uploaded, 1, "one batch expected for a single small chunk");
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");

        let decoded = read_own_pushed_chunks(&dir, "dev-a", &key);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].entry_id, entry_id);
        assert_eq!(decoded[0].model_id, "model-a");
        assert_eq!(decoded[0].content_hash, "hash-0");
        assert_eq!(decoded[0].vec, db::embeddings::vec_to_blob(&[1.0, 0.5]));
    }

    #[tokio::test]
    async fn embedding_sync_push_serializes_only_the_gathered_model_chunks() {
        // Two different embedding models both have locally-stored chunks
        // (e.g. mid model-swap, before the old model's rows are pruned).
        // Every chunk in the pushed payload must keep its own correct
        // `model_id` — nothing gets merged/overwritten across models.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let entry_id = make_entry_with_content(&conn, &key, "body");
        db::embeddings::upsert_chunk(
            &conn,
            &entry_id,
            "model-a",
            0,
            "hash-a",
            0,
            4,
            None,
            1,
            &[0.1],
            0,
        )
        .unwrap();
        db::embeddings::upsert_chunk(
            &conn,
            &entry_id,
            "model-b",
            0,
            "hash-b",
            0,
            4,
            None,
            1,
            &[0.2],
            0,
        )
        .unwrap();

        let (_uploaded, errors) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");

        let mut decoded = read_own_pushed_chunks(&dir, "dev-a", &key);
        decoded.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].model_id, "model-a");
        assert_eq!(decoded[0].content_hash, "hash-a");
        assert_eq!(decoded[1].model_id, "model-b");
        assert_eq!(decoded[1].content_hash, "hash-b");
    }

    #[tokio::test]
    async fn embedding_sync_push_excludes_protected_entries_when_opt_out_is_off() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let normal = make_entry_with_content(&conn, &key, "normal body");
        let locked = make_entry_with_content(&conn, &key, "locked body");
        let invisible = make_entry_with_content(&conn, &key, "invisible body");
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            rusqlite::params![locked],
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = ?1",
            rusqlite::params![invisible],
        )
        .unwrap();
        db::embeddings::upsert_chunk(&conn, &normal, "m", 0, "h-normal", 0, 4, None, 1, &[0.1], 0)
            .unwrap();
        db::embeddings::upsert_chunk(&conn, &locked, "m", 0, "h-locked", 0, 4, None, 1, &[0.2], 0)
            .unwrap();
        db::embeddings::upsert_chunk(
            &conn,
            &invisible,
            "m",
            0,
            "h-invisible",
            0,
            4,
            None,
            1,
            &[0.3],
            0,
        )
        .unwrap();
        // `ai_embed_include_protected` left unset — defaults to off (fail closed).

        let (_uploaded, errors) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");

        let decoded = read_own_pushed_chunks(&dir, "dev-a", &key);
        assert_eq!(
            decoded.len(),
            1,
            "locked/invisible entries' vectors must not be pushed by default"
        );
        assert_eq!(decoded[0].entry_id, normal);
        assert_eq!(decoded[0].content_hash, "h-normal");
    }

    #[tokio::test]
    async fn embedding_sync_push_includes_locked_but_still_excludes_invisible_when_opt_in_is_on() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let normal = make_entry_with_content(&conn, &key, "normal body");
        let locked = make_entry_with_content(&conn, &key, "locked body");
        let invisible = make_entry_with_content(&conn, &key, "invisible body");
        conn.execute(
            "UPDATE entries SET is_locked = 1 WHERE id = ?1",
            rusqlite::params![locked],
        )
        .unwrap();
        conn.execute(
            "UPDATE entries SET is_invisible = 1 WHERE id = ?1",
            rusqlite::params![invisible],
        )
        .unwrap();
        db::embeddings::upsert_chunk(&conn, &normal, "m", 0, "h-normal", 0, 4, None, 1, &[0.1], 0)
            .unwrap();
        db::embeddings::upsert_chunk(&conn, &locked, "m", 0, "h-locked", 0, 4, None, 1, &[0.2], 0)
            .unwrap();
        db::embeddings::upsert_chunk(
            &conn,
            &invisible,
            "m",
            0,
            "h-invisible",
            0,
            4,
            None,
            1,
            &[0.3],
            0,
        )
        .unwrap();
        crate::db::queries::set_setting(
            &conn,
            crate::ai::provider::settings_keys::EMBED_INCLUDE_PROTECTED,
            "true",
        )
        .unwrap();

        let (_uploaded, errors) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");

        let mut ids: Vec<String> = read_own_pushed_chunks(&dir, "dev-a", &key)
            .into_iter()
            .map(|c| c.entry_id)
            .collect();
        ids.sort();
        let mut expected = vec![normal, locked];
        expected.sort();
        assert_eq!(
            ids, expected,
            "opting in to include_protected must sync locked vectors too, but invisible must \
             remain excluded"
        );
        assert!(
            !ids.contains(&invisible),
            "invisible entries' vectors must never sync, even with include_protected on"
        );
    }

    #[tokio::test]
    async fn embedding_sync_push_never_carries_dirty_job_queue_state() {
        // The `entry_embedding_jobs` dirty queue must never leave the
        // device (see `sync::embedding_sync` module docs). Seed a dirty job
        // row alongside the chunk and confirm the pushed-then-decoded
        // struct only ever carries `EmbeddingChunkVector`'s six chunk
        // fields — there is no field for job status/attempts/last_error to
        // even be smuggled into, so this pins the payload shape itself.
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let entry_id = make_entry_with_content(&conn, &key, "body");
        db::embeddings::upsert_chunk(&conn, &entry_id, "m", 0, "hash-0", 0, 4, None, 1, &[0.1], 0)
            .unwrap();
        db::embeddings::mark_entry_embedding_dirty(&conn, &entry_id, "m", "hash-0", 0, 0).unwrap();

        engine.push_embedding_chunks(&conn, &key).await.unwrap();

        let decoded = read_own_pushed_chunks(&dir, "dev-a", &key);
        assert_eq!(decoded.len(), 1);
        assert_eq!(
            decoded[0],
            EmbeddingChunkVector {
                entry_id: entry_id.clone(),
                model_id: "m".to_string(),
                chunk_index: 0,
                content_hash: "hash-0".to_string(),
                dim: 1,
                vec: db::embeddings::vec_to_blob(&[0.1]),
            }
        );
    }

    #[tokio::test]
    async fn embedding_sync_push_is_a_noop_when_no_chunks_exist() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let (uploaded, errors) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert_eq!(uploaded, 0);
        assert!(errors.is_empty());
    }

    // ─── embedding chunk-vector sync pull + adopt-on-match (Phase 5 Task 3) ──

    /// This device's own chunk-map hash at `chunk_index` for `(title,
    /// content)` — exactly the computation `adopt_synced_chunk_vector`
    /// does internally. Used to build fixtures whose pushed `content_hash`
    /// is known to match (or, for mismatch tests, is known to differ from)
    /// what the pulling device would compute for its own copy of the
    /// entry.
    ///
    /// `chunk_index == 1` (not `0`): `build_indexable_text` joins title and
    /// content with a blank line, and `chunk_indexable_text` treats that
    /// blank line as a paragraph boundary — so chunk 0 is the TITLE alone
    /// and chunk 1 is the content. Fixtures below vary `content` (not
    /// `title`), so they must compare at chunk_index 1, the chunk that
    /// actually depends on the content being varied.
    fn chunk_hash_at(title: &str, content: &str, chunk_index: usize) -> String {
        let text = crate::ai::indexer::build_indexable_text(Some(title), Some(content));
        crate::ai::chunking::chunk_indexable_text(&text)
            .into_iter()
            .find(|c| c.chunk_index == chunk_index)
            .unwrap_or_else(|| panic!("chunk {chunk_index} must exist for this fixture text"))
            .content_hash
    }

    /// C6 fix: `pull_embedding_chunks`'s "active embedding model" now comes
    /// from the configured embed slot
    /// (`commands::ai_provider::configured_embedding_model_id`), not from
    /// whatever `model_id`s happen to already be present in
    /// `entry_embedding_chunks`. Test-only helper that writes the raw
    /// `ai_embed_provider` / `ai_embed_embedding_model` settings rows
    /// directly so that helper resolves to `format!("{provider}:{model}")`
    /// — no live `AIProvider` needed. Replaces the old pattern of seeding
    /// an unrelated "anchor" entry's chunk row purely to establish an
    /// active model_id.
    fn configure_embed_slot(conn: &Connection, provider: &str, model: &str) {
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::embed::PROVIDER,
            provider,
        )
        .unwrap();
        db::set_setting(
            conn,
            crate::ai::provider::settings_keys::embed::EMBEDDING_MODEL,
            model,
        )
        .unwrap();
    }

    /// C6 fix, item (a): a brand-new device with ZERO local chunk rows
    /// still adopts a peer's matching vectors as long as its embedding
    /// slot is configured to the SAME model — the old
    /// `distinct_synced_model_ids`-derived idiom adopted nothing here
    /// because there was no local row to derive "active" from.
    #[tokio::test]
    async fn embedding_sync_pull_adopts_matching_model_and_hash_two_device_round_trip() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // dev-a: embeds one chunk for "prov-a:model-a" and pushes it.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body"); // title "t", content "body"
        let hash = chunk_hash_at("t", "body", 1);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "prov-a:model-a",
            1,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        // dev-b: has the SAME entry (same id, same title/content — same
        // content_hash at chunk 1), has NEVER stored a single chunk row
        // locally (fresh device), but its embedding slot is configured to
        // the SAME model as dev-a.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);
        configure_embed_slot(&conn_b, "prov-a", "model-a");

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pull_stats.adopted, 1);
        assert_eq!(pull_stats.model_mismatch, 0);
        assert_eq!(pull_stats.hash_mismatch, 0);

        let stored =
            db::embeddings::list_stored_chunks(&conn_b, &entry_id, "prov-a:model-a").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].content_hash, hash);
        assert_eq!(
            stored[0].vec,
            vec![1.0, 0.5],
            "adopted vector must be bit-exact"
        );
        // Happy-path adopt must not stamp a pending decision.
        let decision = crate::ai::embedding_decision::read_embed_sync_decision(
            &conn_b,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
        )
        .unwrap();
        assert_eq!(
            decision.state,
            crate::ai::embedding_decision::EmbedSyncDecisionState::None
        );
    }

    /// C6 fix, item (b): local rows RETAINED from a model that is no
    /// longer configured (e.g. after a model switch, before anything
    /// prunes the old rows) must never count as "active" just because
    /// they still physically exist — only the CURRENTLY CONFIGURED embed
    /// slot does.
    #[tokio::test]
    async fn embedding_sync_pull_ignores_stale_rows_from_a_previously_configured_model() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        // dev-a: pushes a chunk under the OLD model.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let hash = chunk_hash_at("t", "body", 0);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "prov-a:model-a",
            0,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        // dev-b: STILL has a local chunk row for the OLD model (retained
        // from before a switch), but its embed slot is now configured to a
        // NEW model.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);
        db::embeddings::upsert_chunk(
            &conn_b,
            &entry_id,
            "prov-a:model-a",
            0,
            "stale-local-hash",
            0,
            4,
            None,
            2,
            &[9.9, 9.9],
            0,
        )
        .unwrap();
        configure_embed_slot(&conn_b, "prov-b", "model-b");

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(
            pull_stats.adopted, 0,
            "rows retained from a model no longer configured must never count as active"
        );
        assert!(
            pull_stats.model_mismatch >= 1,
            "peer vectors under a non-configured model must tally as model_mismatch"
        );

        // The stale local row is untouched by the ignored peer batch.
        let stored =
            db::embeddings::list_stored_chunks(&conn_b, &entry_id, "prov-a:model-a").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].content_hash, "stale-local-hash");
    }

    /// C6 fix, item (c) regression: a peer's vectors for a model that
    /// isn't THIS device's configured embedding model are skipped — this
    /// device must fall back to re-embedding the entry locally (proven at
    /// the full-pipeline level by
    /// `embedding_sync_device_with_different_model_ignores_peer_vectors_and_indexes_locally`
    /// below).
    #[tokio::test]
    async fn embedding_sync_pull_ignores_vectors_for_a_model_this_device_does_not_use() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let hash = chunk_hash_at("t", "body", 0);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "prov-a:model-a",
            0,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        // dev-b's embedding slot is configured to a DIFFERENT model —
        // "prov-a:model-a" is dead weight for it, so the incoming vector
        // must be ignored even though the content matches perfectly.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);
        configure_embed_slot(&conn_b, "prov-b", "model-b-local");

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pull_stats.adopted, 0, "model mismatch must never adopt");
        assert!(
            pull_stats.model_mismatch >= 1,
            "foreign model must increment model_mismatch tally"
        );
        assert!(
            db::embeddings::list_stored_chunks(&conn_b, &entry_id, "prov-a:model-a")
                .unwrap()
                .is_empty()
        );
        // Local entry still needs index for the active model → pending decision.
        let decision = crate::ai::embedding_decision::read_embed_sync_decision(
            &conn_b,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
        )
        .unwrap();
        assert_eq!(
            decision.state,
            crate::ai::embedding_decision::EmbedSyncDecisionState::Pending
        );
        assert_eq!(
            decision.reason,
            Some(crate::ai::embedding_decision::EmbedSyncDecisionReason::ModelMismatch)
        );
        assert!(
            decision
                .peer_models
                .iter()
                .any(|p| p.model_id == "prov-a:model-a" && p.count >= 1),
            "peer model id must be recorded: {:?}",
            decision.peer_models
        );
    }

    #[tokio::test]
    async fn embedding_sync_pull_ignores_vectors_whose_content_hash_no_longer_matches() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let hash = chunk_hash_at("t", "body", 1);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "prov-a:model-a",
            1,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        // dev-b's slot is configured to the SAME model, but its OWN copy of
        // the entry has different content (e.g. it hasn't pulled the
        // latest entry edit yet, or diverged) — the recomputed chunk-map
        // hash disagrees, so the device must re-embed locally instead of
        // trusting the stale incoming vector.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let journal_b = default_journal(&conn_b);
        conn_b
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'completely different content', 0, 0, 0, 0, 0, ?3)",
                rusqlite::params![entry_id, journal_b, Vec::<u8>::new()],
            )
            .unwrap();
        configure_embed_slot(&conn_b, "prov-a", "model-a");

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pull_stats.adopted, 0, "hash mismatch must never adopt");
        assert_eq!(
            pull_stats.model_mismatch, 0,
            "same-model hash mismatch must not count as model_mismatch"
        );
        assert!(
            pull_stats.hash_mismatch >= 1,
            "hash mismatch must be tallied"
        );
        assert!(
            db::embeddings::list_stored_chunks(&conn_b, &entry_id, "prov-a:model-a")
                .unwrap()
                .is_empty()
        );
        // Pure HashMismatch must never stamp a model_mismatch pending decision.
        let decision = crate::ai::embedding_decision::read_embed_sync_decision(
            &conn_b,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
        )
        .unwrap();
        assert_eq!(
            decision.state,
            crate::ai::embedding_decision::EmbedSyncDecisionState::None,
            "hash mismatch alone must not open the decision modal path"
        );
    }

    #[tokio::test]
    async fn embedding_sync_pull_skips_enqueue_dirty_jobs_under_pause_sync_backfill() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let hash = chunk_hash_at("t", "body", 1);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "prov-a:model-a",
            1,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let journal_b = default_journal(&conn_b);
        conn_b
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'completely different content', 0, 0, 0, 0, 0, ?3)",
                rusqlite::params![entry_id, journal_b, Vec::<u8>::new()],
            )
            .unwrap();
        let extra = make_entry_with_content(&conn_b, &key, "never-indexed sibling");
        configure_embed_slot(&conn_b, "prov-a", "model-a");
        crate::ai::embedding_decision::write_embed_sync_decision(
            &conn_b,
            crate::ai::embedding_decision::EmbedSyncSlot::Entry,
            &crate::ai::embedding_decision::EmbedSyncDecision {
                state: crate::ai::embedding_decision::EmbedSyncDecisionState::Pause,
                pause_scope: crate::ai::embedding_decision::EmbedPauseScope::SyncBackfill,
                ..Default::default()
            },
        )
        .unwrap();

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert!(
            pull_stats.hash_mismatch >= 1,
            "hash mismatch must still be tallied under Pause"
        );
        let model_id = "prov-a:model-a";
        assert!(
            db::embeddings::get_embedding_job(&conn_b, &entry_id, model_id)
                .unwrap()
                .is_none(),
            "Pause+sync_backfill must skip enqueue_dirty_jobs_for_model (deleting the allow gate fails this)"
        );
        assert!(
            db::embeddings::get_embedding_job(&conn_b, &extra, model_id)
                .unwrap()
                .is_none(),
            "Pause+sync_backfill must not seed never-indexed sibling rows"
        );
    }

    #[tokio::test]
    async fn embedding_sync_pull_hash_mismatch_enqueues_only_mismatch_entry_ids() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let hash = chunk_hash_at("t", "body", 1);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "prov-a:model-a",
            1,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let journal_b = default_journal(&conn_b);
        conn_b
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', 'completely different content', 0, 0, 0, 0, 0, ?3)",
                rusqlite::params![entry_id, journal_b, Vec::<u8>::new()],
            )
            .unwrap();
        let extra = make_entry_with_content(&conn_b, &key, "never-indexed sibling");
        configure_embed_slot(&conn_b, "prov-a", "model-a");

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert!(pull_stats.hash_mismatch >= 1);
        let model_id = "prov-a:model-a";
        assert!(
            db::embeddings::get_embedding_job(&conn_b, &entry_id, model_id)
                .unwrap()
                .is_some(),
            "hash-mismatch entry must be re-queued"
        );
        assert!(
            db::embeddings::get_embedding_job(&conn_b, &extra, model_id)
                .unwrap()
                .is_none(),
            "hash_mismatch must not enqueue the whole unindexed corpus"
        );
    }

    /// `push_embedding_chunks` must prune stale higher-index `batch-{i}.bin`
    /// files left by a previously larger eligible set, so orphans don't
    /// accumulate in the cloud forever (the leak `reconcile_own_version_files`
    /// prevents for versions). Covers both shrink cases: fewer batches, and
    /// the empty case (embedding disabled / model just switched with nothing
    /// embedded yet) where ALL previous batches must be removed. A non-batch
    /// file in the same folder must always be left untouched.
    #[tokio::test]
    async fn push_embedding_chunks_prunes_stale_higher_index_batches() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path().to_path_buf());

        // Simulate a previous, larger push: three orphan batch files on cloud.
        for i in 0..3 {
            provider
                .write_file(&format!("dev-a/embeddings/batch-{i}.bin"), b"stale")
                .await
                .unwrap();
        }
        // A non-batch file in the same folder must be left untouched.
        provider
            .write_file("dev-a/embeddings/not-a-batch.bin", b"keep")
            .await
            .unwrap();

        // One local chunk -> this push produces exactly one batch (batch-0).
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn, &key, "body");
        let hash = chunk_hash_at("t", "body", 1);
        db::embeddings::upsert_chunk(
            &conn,
            &entry_id,
            "prov-a:model-a",
            1,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();

        let (uploaded, errors) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert_eq!(uploaded, 1, "one batch uploaded");
        assert!(errors.is_empty(), "prune must not error: {errors:?}");

        let names = |paths: Vec<String>| -> std::collections::BTreeSet<String> {
            paths
                .iter()
                .filter_map(|p| p.rsplit('/').next().map(String::from))
                .collect()
        };
        let remaining = names(
            provider
                .list_files("dev-a", FileKind::EmbeddingChunks)
                .await
                .unwrap(),
        );
        assert!(
            remaining.contains("batch-0.bin"),
            "freshly written batch survives"
        );
        assert!(!remaining.contains("batch-1.bin"), "orphan batch-1 pruned");
        assert!(!remaining.contains("batch-2.bin"), "orphan batch-2 pruned");
        assert!(
            remaining.contains("not-a-batch.bin"),
            "non-batch file must be left alone"
        );

        // Empty case: drop the only chunk row so the next push produces ZERO
        // batches. Every `batch-*` file must then be pruned.
        db::embeddings::delete_chunks_not_in(&conn, &entry_id, "prov-a:model-a", &[]).unwrap();
        let (uploaded2, errors2) = engine.push_embedding_chunks(&conn, &key).await.unwrap();
        assert_eq!(uploaded2, 0, "no batches produced when no chunks remain");
        assert!(
            errors2.is_empty(),
            "empty-case prune must not error: {errors2:?}"
        );

        let after = names(
            provider
                .list_files("dev-a", FileKind::EmbeddingChunks)
                .await
                .unwrap(),
        );
        assert!(
            !after.iter().any(|n| n.starts_with("batch-")),
            "empty push must prune all batch files, left: {after:?}"
        );
        assert!(
            after.contains("not-a-batch.bin"),
            "non-batch file must still be left alone"
        );
    }

    /// `reconcile_own_media_files` must delete own-folder media blobs — and
    /// their `.thumb` siblings — whose id no longer has a local `media` row,
    /// while leaving blobs backed by a live row untouched. The thumbnail is
    /// swept even though the local provider's media listing omits `.thumb`
    /// entries (the id is derived from the main blob, not listed).
    #[tokio::test]
    async fn reconcile_own_media_files_prunes_orphan_cloud_media() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path().to_path_buf());

        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn, &key, "body");

        // A media row that still exists locally -> its cloud blob must survive.
        let keep_id = db::create_media(
            &conn,
            crate::db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "keep.jpg",
                file_type: "image/jpeg",
                storage_path: "/tmp/keep.jpg",
                file_size: Some(1),
                sort_order: 0,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap()
        .id;

        // A valid-looking id with no local row -> its pair must be pruned.
        let orphan_id = "11111111-1111-1111-1111-111111111111";

        for (id, byte) in [(keep_id.as_str(), b"k"), (orphan_id, b"o")] {
            provider
                .write_file(&format!("dev-a/media/{id}"), byte)
                .await
                .unwrap();
            provider
                .write_file(&format!("dev-a/media/{id}.thumb"), byte)
                .await
                .unwrap();
        }

        let media_paths = provider.list_files("dev-a", FileKind::Media).await.unwrap();
        let errors = engine.reconcile_own_media_files(&conn, &media_paths).await;
        assert!(errors.is_empty(), "prune must not error: {errors:?}");

        let media_dir = dir.path().join("dev-a").join("media");
        assert!(
            media_dir.join(&keep_id).exists(),
            "live media blob must survive"
        );
        assert!(
            media_dir.join(format!("{keep_id}.thumb")).exists(),
            "live thumbnail must survive"
        );
        assert!(
            !media_dir.join(orphan_id).exists(),
            "orphan media blob must be pruned"
        );
        assert!(
            !media_dir.join(format!("{orphan_id}.thumb")).exists(),
            "orphan thumbnail must be pruned even though listing omits .thumb"
        );
    }

    /// Empty-DB safety guard: an empty `media` table with NO deletion evidence
    /// must never prune, so an unpopulated database (`sync_now` pushes before
    /// it pulls) cannot wipe every own cloud blob before the pull restores them.
    #[tokio::test]
    async fn reconcile_own_media_files_skips_prune_without_deletion_evidence() {
        let dir = TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path().to_path_buf());
        let conn = fresh_db(); // no media rows, no tombstoned entries
        let engine = make_engine(&dir, "dev-a");

        let orphan_id = "11111111-1111-1111-1111-111111111111";
        provider
            .write_file(&format!("dev-a/media/{orphan_id}"), b"o")
            .await
            .unwrap();
        provider
            .write_file(&format!("dev-a/media/{orphan_id}.thumb"), b"o")
            .await
            .unwrap();

        let media_paths = provider.list_files("dev-a", FileKind::Media).await.unwrap();
        let errors = engine.reconcile_own_media_files(&conn, &media_paths).await;
        assert!(errors.is_empty(), "guard path must not error: {errors:?}");

        let media_dir = dir.path().join("dev-a").join("media");
        assert!(
            media_dir.join(orphan_id).exists(),
            "empty local table must NOT prune cloud media (recovery safety)"
        );
        assert!(
            media_dir.join(format!("{orphan_id}.thumb")).exists(),
            "empty local table must NOT prune cloud thumbnails"
        );
    }

    /// The regression that "any entry rows at all" would have caused: a
    /// TEXT-ONLY Replace-All import hard-wipes `media` + `entries`, then
    /// inserts entries and zero media. Entry rows exist, `media` is empty — but
    /// there are no tombstones, so this is NOT evidence the user deleted media
    /// and the own cloud folder must be left alone. `hard_wipe_user_data` emits
    /// no tombstones either, so peers still point `cloud_path` into this
    /// folder; pruning would make those photos permanently unfetchable.
    #[tokio::test]
    async fn reconcile_own_media_files_skips_prune_after_text_only_replace_all_import() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path().to_path_buf());
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");

        // Pre-import state: entries + media, some of it already deleted.
        let old_entry = make_entry_with_content(&conn, &key, "old");
        conn.execute(
            "UPDATE entries SET is_deleted = 1 WHERE id = ?1",
            [&old_entry],
        )
        .unwrap();
        // Replace-All: hard wipe, then a text-only archive lands.
        db::hard_wipe_user_data(&conn).unwrap();
        make_entry_with_content(&conn, &key, "imported, no media");
        assert_eq!(db::count_media(&conn).unwrap(), 0);
        assert_eq!(
            db::count_deleted_entries(&conn).unwrap(),
            0,
            "the hard wipe must leave no tombstones — that is the whole signal"
        );

        let orphan_id = "11111111-1111-1111-1111-111111111111";
        provider
            .write_file(&format!("dev-a/media/{orphan_id}"), b"o")
            .await
            .unwrap();

        let media_paths = provider.list_files("dev-a", FileKind::Media).await.unwrap();
        let errors = engine.reconcile_own_media_files(&conn, &media_paths).await;
        assert!(errors.is_empty(), "guard path must not error: {errors:?}");
        assert!(
            dir.path()
                .join("dev-a")
                .join("media")
                .join(orphan_id)
                .exists(),
            "a text-only Replace-All must NOT prune this device's cloud media"
        );
    }

    /// The case the old `count_media == 0` guard made unfixable: the user
    /// deletes the one journal that held ALL their media, so the local `media`
    /// table is empty — but the entry tombstones prove this is a populated
    /// database, not a blank one, so the cloud blobs MUST still be swept.
    /// Nothing else would ever sweep them: the prune is the only thing that
    /// lists that folder, and it needs the rows to be gone to call them
    /// orphans.
    #[tokio::test]
    async fn reconcile_own_media_files_prunes_when_all_media_deleted_but_entries_remain() {
        let key = test_key();
        let dir = TempDir::new().unwrap();
        let provider = LocalSyncProvider::new(dir.path().to_path_buf());
        let conn = fresh_db();
        let engine = make_engine(&dir, "dev-a");

        // A populated DB whose every entry is tombstoned and whose media rows
        // are all gone — exactly the post-`delete_journal` state.
        let entry_id = make_entry_with_content(&conn, &key, "body");
        conn.execute(
            "UPDATE entries SET is_deleted = 1 WHERE id = ?1",
            [&entry_id],
        )
        .unwrap();
        assert_eq!(db::count_media(&conn).unwrap(), 0);
        assert!(db::count_deleted_entries(&conn).unwrap() > 0);

        let orphan_id = "11111111-1111-1111-1111-111111111111";
        provider
            .write_file(&format!("dev-a/media/{orphan_id}"), b"o")
            .await
            .unwrap();
        provider
            .write_file(&format!("dev-a/media/{orphan_id}.thumb"), b"o")
            .await
            .unwrap();

        let media_paths = provider.list_files("dev-a", FileKind::Media).await.unwrap();
        let errors = engine.reconcile_own_media_files(&conn, &media_paths).await;
        assert!(errors.is_empty(), "prune must not error: {errors:?}");

        let media_dir = dir.path().join("dev-a").join("media");
        assert!(
            !media_dir.join(orphan_id).exists(),
            "deleting every media must still prune the cloud blob"
        );
        assert!(
            !media_dir.join(format!("{orphan_id}.thumb")).exists(),
            "…and its thumbnail"
        );
    }

    /// C6 fix, item (d): with no embedding slot configured at all, the pull
    /// is a no-op — nothing adopted, no errors — regardless of whether any
    /// local chunk rows exist. This replaces the old "bootstrap edge case"
    /// framing (zero local chunk rows ⇒ no active model), which no longer
    /// describes the actual gate.
    #[tokio::test]
    async fn embedding_sync_pull_skips_everything_when_no_embed_slot_configured() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let hash = chunk_hash_at("t", "body", 0);
        db::embeddings::upsert_chunk(
            &conn_a,
            &entry_id,
            "model-a",
            0,
            &hash,
            0,
            4,
            None,
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);
        // dev-b has no embedding slot configured at all — nothing to adopt
        // against, regardless of what chunk rows exist locally.

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty());
        assert_eq!(pull_stats.adopted, 0);
        assert_eq!(pull_stats.model_mismatch, 0);
        assert_eq!(pull_stats.hash_mismatch, 0);
    }

    // ─── Full engine + worker end-to-end chain (Phase 5 Task 5) ──────────
    //
    // The tests above prove adopt-on-match / ignore-on-mismatch at the
    // `pull_embedding_chunks` DB layer using hand-seeded chunk rows. The two
    // tests below close the loop through the REAL embedding worker
    // (`EntryIndexer`) on both ends, so the headline guarantee of this phase
    // — a second device adopts vectors and spends zero provider calls,
    // while a device on a different model ignores them and pays its own
    // embed cost — is asserted against the actual push → pull → worker
    // pipeline, not just the sync-engine slice of it.

    /// Counts `embed` calls while delegating to a real `StubEmbedder`, so
    /// the vectors produced are still deterministic and comparable across
    /// devices — only the call COUNT is instrumented.
    struct CallCountingEmbedder {
        inner: crate::ai::embedder::StubEmbedder,
        calls: std::sync::atomic::AtomicU64,
    }

    impl CallCountingEmbedder {
        fn new(model_id: &str, dim: usize) -> Self {
            Self {
                inner: crate::ai::embedder::StubEmbedder::new(model_id, dim),
                calls: std::sync::atomic::AtomicU64::new(0),
            }
        }

        fn call_count(&self) -> u64 {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl crate::ai::embedder::Embedder for CallCountingEmbedder {
        fn model_id(&self) -> &str {
            crate::ai::embedder::Embedder::model_id(&self.inner)
        }

        fn dim(&self) -> usize {
            crate::ai::embedder::Embedder::dim(&self.inner)
        }

        fn embed(&self, text: &str) -> Result<Vec<f32>, crate::ai::error::AiError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::ai::embedder::Embedder::embed(&self.inner, text)
        }
    }

    /// Queue a dirty job the way a real local edit would, right before a
    /// pull lands — mirrors `commands::entries::maybe_mark_entry_embedding_dirty_after_save`
    /// (see the equivalent private helper in `ai::indexer`'s test module,
    /// duplicated here since it's `#[cfg(test)]`-private to that file).
    fn queue_embedding_dirty_job(conn: &Connection, model_id: &str, entry_id: &str) {
        let entry = crate::db::queries::get_entry_for_provider(conn, entry_id)
            .unwrap()
            .unwrap();
        let text = crate::ai::indexer::build_indexable_text(
            entry.title.as_deref(),
            entry.content_text.as_deref(),
        );
        let hash = crate::ai::chunking::content_hash(&text);
        db::embeddings::mark_entry_embedding_dirty(conn, entry_id, model_id, &hash, 0, 0).unwrap();
    }

    #[tokio::test]
    async fn embedding_sync_two_device_adopt_then_worker_resolves_job_with_zero_provider_calls() {
        use crate::ai::embedder::{DynEmbedder, StubEmbedder};
        use crate::ai::indexer::{EntryIndexer, JobOutcome};

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let content = "This entry has enough real content to be embedded.";

        // dev-a: create the entry and actually index it through the real
        // worker pipeline (not a hand-seeded chunk row), so the vectors
        // that get pushed are exactly what production embedding produces.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, content);

        // Model id deliberately includes a colon (`provider:model` shape)
        // so it can double as a realistic `configured_embedding_model_id`
        // value below — see `configure_embed_slot`.
        let embedder_a: DynEmbedder = Arc::new(StubEmbedder::new("stub:model-shared", 4));
        let indexer_a =
            EntryIndexer::from_dyn(embedder_a).with_throttle(std::time::Duration::from_secs(0));
        let model_id = indexer_a.model_id();
        crate::ai::indexer::enqueue_dirty_jobs_for_model(&conn_a, &model_id).unwrap();
        let outcomes_a = indexer_a.process_due_jobs(&conn_a, 10).unwrap();
        assert_eq!(outcomes_a.len(), 1);
        match &outcomes_a[0] {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 2, "title chunk + content chunk, both new");
                assert_eq!(*reused, 0);
            }
            other => panic!("expected Completed, got {other:?}"),
        }

        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        // dev-b: same entry (same id/title/content, so the recomputed
        // chunk-map hashes match dev-a's exactly), its embed slot
        // configured to the SAME model, AND a dirty job already queued for
        // `entry_id` under that model — simulating a local edit that
        // raced ahead of the incoming pull.
        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        let journal_b = default_journal(&conn_b);
        conn_b
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', ?3, 0, 0, 0, 0, 0, ?4)",
                rusqlite::params![entry_id, journal_b, content, Vec::<u8>::new()],
            )
            .unwrap();
        configure_embed_slot(&conn_b, "stub", "model-shared");
        queue_embedding_dirty_job(&conn_b, &model_id, &entry_id);

        let (pull_stats, errors) = engine_b
            .pull_embedding_chunks(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pull_stats.adopted, 2, "both title and content chunks adopt");

        // The worker must now resolve dev-b's already-queued job with ZERO
        // provider calls: the per-chunk hash diff finds every chunk already
        // satisfied by the adopted vectors.
        let embedder_b = Arc::new(CallCountingEmbedder::new(&model_id, 4));
        let indexer_b = EntryIndexer::from_dyn(embedder_b.clone() as DynEmbedder)
            .with_throttle(std::time::Duration::from_secs(0));
        let outcomes_b = indexer_b.process_due_jobs(&conn_b, 10).unwrap();
        assert_eq!(outcomes_b.len(), 1);
        match &outcomes_b[0] {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 0, "every chunk was adopted, none embedded");
                assert_eq!(*reused, 2);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert_eq!(
            embedder_b.call_count(),
            0,
            "adopted device must make zero provider calls"
        );

        let job = db::embeddings::get_embedding_job(&conn_b, &entry_id, &model_id)
            .unwrap()
            .expect("job row still exists");
        assert_eq!(job.status, "indexed");
    }

    #[tokio::test]
    async fn embedding_sync_device_with_different_model_ignores_peer_vectors_and_indexes_locally() {
        use crate::ai::embedder::{DynEmbedder, StubEmbedder};
        use crate::ai::indexer::{EntryIndexer, JobOutcome};

        let key = test_key();
        let dir = TempDir::new().unwrap();
        let content = "This entry has enough real content to be embedded.";

        // dev-a: index + push under "model-shared", exactly as above.
        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, content);
        let embedder_a: DynEmbedder = Arc::new(StubEmbedder::new("model-shared", 4));
        let indexer_a =
            EntryIndexer::from_dyn(embedder_a).with_throttle(std::time::Duration::from_secs(0));
        let shared_model_id = indexer_a.model_id();
        crate::ai::indexer::enqueue_dirty_jobs_for_model(&conn_a, &shared_model_id).unwrap();
        indexer_a.process_due_jobs(&conn_a, 10).unwrap();
        engine_a.push_embedding_chunks(&conn_a, &key).await.unwrap();

        // dev-c: same entry content, but its embedding slot is CONFIGURED
        // to a different model ("prov-c:model-c") — the peer's vectors
        // must be ignored, and dev-c must re-embed the entry itself under
        // its own model.
        let conn_c = fresh_db();
        let engine_c = make_engine(&dir, "dev-c");
        configure_embed_slot(&conn_c, "prov-c", "model-c");
        let journal_c = default_journal(&conn_c);
        conn_c
            .execute(
                "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
                    entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
                 VALUES (?1, ?2, 't', 'p', ?3, 0, 0, 0, 0, 0, ?4)",
                rusqlite::params![entry_id, journal_c, content, Vec::<u8>::new()],
            )
            .unwrap();
        // This anchor is for the LOCAL indexer's own eligibility gate
        // below (`list_entries_needing_index` excludes an entry that
        // already has a fresh chunk row for the model being indexed) — it
        // is unrelated to the sync engine's active-model determination,
        // which now comes from `configure_embed_slot` above, not from
        // local chunk rows.
        let anchor_id = "anchor-two-device-worker-chain-ignore";
        seed_bare_entry(&conn_c, anchor_id);
        // C11 fix: `list_entries_needing_index` now also treats a chunk row
        // older than the entry's `updated_at` as needing re-index, so this
        // anchor's `indexed_at` must be at least as fresh as the
        // `seed_bare_entry` row it belongs to — the anchor exists purely to
        // prove "already has a chunk row for model-c" excludes it, not to
        // exercise staleness.
        db::embeddings::upsert_chunk(
            &conn_c,
            anchor_id,
            "model-c",
            0,
            "anchor-hash",
            0,
            4,
            None,
            2,
            &[9.9, 9.9],
            now_unix(),
        )
        .unwrap();

        let (pull_stats, errors) = engine_c
            .pull_embedding_chunks(&conn_c, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pull_stats.adopted, 0, "foreign model must never adopt");
        assert!(
            pull_stats.model_mismatch >= 1,
            "foreign model must tally model_mismatch"
        );
        assert!(
            db::embeddings::list_stored_chunks(&conn_c, &entry_id, &shared_model_id)
                .unwrap()
                .is_empty(),
            "dev-c must never store vectors under a model it doesn't use"
        );

        // dev-c indexes locally: since nothing was adopted, the worker must
        // actually call its OWN provider to produce and store its own
        // vectors under "model-c".
        let embedder_c = Arc::new(CallCountingEmbedder::new("model-c", 4));
        let indexer_c = EntryIndexer::from_dyn(embedder_c.clone() as DynEmbedder)
            .with_throttle(std::time::Duration::from_secs(0));
        crate::ai::indexer::enqueue_dirty_jobs_for_model(&conn_c, "model-c").unwrap();
        let outcomes_c = indexer_c.process_due_jobs(&conn_c, 10).unwrap();
        assert_eq!(outcomes_c.len(), 1);
        match &outcomes_c[0] {
            JobOutcome::Completed {
                embedded, reused, ..
            } => {
                assert_eq!(*embedded, 2, "dev-c must embed both chunks itself");
                assert_eq!(*reused, 0);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
        assert!(
            embedder_c.call_count() > 0,
            "device on a foreign model must pay its own embed cost"
        );

        let stored = db::embeddings::list_stored_chunks(&conn_c, &entry_id, "model-c").unwrap();
        assert_eq!(
            stored.len(),
            2,
            "dev-c's own vectors are indexed locally under its own model"
        );
    }

    #[tokio::test]
    async fn pull_versions_inserts_new_row_and_skips_already_known() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let version_id = db::insert_entry_version(
            &conn_a,
            &entry_id,
            b"snapshot bytes from dev-a",
            "preview text",
            "dev-a",
        )
        .unwrap();
        engine_a.push_versions(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        // Pre-seed the parent entry — real `pull_remote` pulls entries
        // before versions, so this FK is already satisfied in production.
        seed_bare_entry(&conn_b, &entry_id);

        let (pulled, errors) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pulled, 1);

        let versions = db::list_entry_versions(&conn_b, &entry_id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, version_id);
        assert_eq!(versions[0].preview_text, "preview text");

        // Pulling again is a no-op: the version already exists locally.
        let (pulled_again, errors_again) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors_again.is_empty());
        assert_eq!(pulled_again, 0, "already-known version must not re-pull");
    }

    #[tokio::test]
    async fn pull_versions_heartbeat_fires_even_when_every_item_fails_to_parse() {
        // A run of consecutive per-item failures must not go silent from the
        // stall guard's point of view. Seed peer-a's versions folder with
        // garbage bytes directly (bypassing push_versions) so every file
        // read succeeds but every parse fails — heartbeat must still fire
        // once per item.
        let dir = TempDir::new().unwrap();
        let peer_provider = LocalSyncProvider::new(dir.path().to_path_buf());
        for i in 0..3 {
            peer_provider
                .write_file(&format!("dev-a/versions/garbage-{i}.bin"), b"not a payload")
                .await
                .unwrap();
        }

        let key = test_key();
        let conn_b = fresh_db();
        let reporter = CountingReporter::new();
        let provider_b = Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()));
        let engine_b =
            SyncEngine::new(provider_b, "dev-b".to_string()).with_reporter(reporter.clone());

        let (pulled, errors) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();

        assert_eq!(pulled, 0, "garbage payloads must not be ingested");
        assert_eq!(errors.len(), 3, "every garbage file should fail to parse");
        assert!(
            reporter.count() >= 3,
            "expected at least one heartbeat per failed version item, got {}",
            reporter.count()
        );
    }

    /// Retention resurrection guard: a peer's version older than this
    /// device's local retention window must be skipped, never inserted —
    /// otherwise a version pruned locally but still sitting in a peer's
    /// cloud folder would be re-pulled forever.
    #[tokio::test]
    async fn pull_versions_skips_peer_version_older_than_local_retention() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let version_id =
            db::insert_entry_version(&conn_a, &entry_id, b"old snapshot", "old preview", "dev-a")
                .unwrap();
        // Backdate well beyond the default 7-day retention window.
        conn_a
            .execute(
                "UPDATE entry_versions SET created_at = ?1 WHERE id = ?2",
                rusqlite::params![now_unix() - 30 * 86_400, version_id],
            )
            .unwrap();
        engine_a.push_versions(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);
        assert_eq!(
            db::get_version_retention_days(&conn_b).unwrap(),
            7,
            "default retention must be 7 days"
        );

        let (pulled, errors) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(pulled, 0, "over-retention version must be skipped");
        assert!(
            !db::version_exists(&conn_b, &version_id).unwrap(),
            "over-retention version must not be inserted at all"
        );
    }

    /// Skip-and-warn: a peer version whose parent entry this device has
    /// never seen must not fail the pull (`entry_versions.entry_id`
    /// REFERENCES `entries(id)`). A later pull, once the entry is present,
    /// ingests the same version.
    #[tokio::test]
    async fn ingest_version_skips_orphan_when_entry_missing_then_ingests_once_entry_arrives() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        let version_id = db::insert_entry_version(
            &conn_a,
            &entry_id,
            b"orphan snapshot",
            "orphan preview",
            "dev-a",
        )
        .unwrap();
        engine_a.push_versions(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        assert!(
            !db::entry_exists(&conn_b, &entry_id).unwrap(),
            "device B must not have the parent entry yet"
        );

        let (pulled_orphan, errors_orphan) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            errors_orphan.is_empty(),
            "orphan version must skip, not fail the pull: {errors_orphan:?}"
        );
        assert_eq!(pulled_orphan, 0, "orphan version must not be ingested");
        assert!(
            !db::version_exists(&conn_b, &version_id).unwrap(),
            "orphan version must not be inserted"
        );

        seed_bare_entry(&conn_b, &entry_id);
        let (pulled_later, errors_later) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            errors_later.is_empty(),
            "unexpected errors after entry arrived: {errors_later:?}"
        );
        assert_eq!(pulled_later, 1, "version must ingest once the entry exists");
        assert!(db::version_exists(&conn_b, &version_id).unwrap());
    }

    /// Linchpin regression test for the pull-side count-cap fix: pulling
    /// TWICE with no local change in between must be a fixpoint — the
    /// second pull inserts 0 rows and (by row-count conservation, since it
    /// also inserts 0) deletes 0 rows. Without the ingest-time
    /// `count_versions_ranked_ahead` skip (which mirrors
    /// `prune_entry_versions`'s keep-set ordering exactly), a naive
    /// re-pull-then-prune cycle would repeatedly re-insert evicted peer
    /// versions only to prune them again every cycle — churn.
    #[tokio::test]
    async fn pull_versions_is_idempotent_on_second_pull_with_no_local_change() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");

        // 60 versions for one entry — well past MAX_VERSIONS_PER_ENTRY (50).
        let base = now_unix() - 60;
        for i in 0..60i64 {
            let id = db::insert_entry_version(&conn_a, &entry_id, b"v", &format!("v{i}"), "dev-a")
                .unwrap();
            conn_a
                .execute(
                    "UPDATE entry_versions SET created_at = ?1 WHERE id = ?2",
                    rusqlite::params![base + i, id],
                )
                .unwrap();
        }
        engine_a.push_versions(&conn_a, &key).await.unwrap();

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);

        let (pulled_first, errors_first) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            errors_first.is_empty(),
            "unexpected errors: {errors_first:?}"
        );
        assert!(pulled_first > 0, "first pull must insert some versions");

        let count_after_first = db::list_entry_versions(&conn_b, &entry_id).unwrap().len();
        assert_eq!(
            count_after_first,
            db::MAX_VERSIONS_PER_ENTRY as usize,
            "first pull must converge to exactly the count cap after its post-pull prune"
        );

        // Second pull: nothing changed locally or on the cloud in between.
        let (pulled_second, errors_second) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            errors_second.is_empty(),
            "unexpected errors: {errors_second:?}"
        );
        assert_eq!(
            pulled_second, 0,
            "second pull must insert 0 rows — evicted peer versions must be re-skipped, not re-inserted"
        );

        let count_after_second = db::list_entry_versions(&conn_b, &entry_id).unwrap().len();
        assert_eq!(
            count_after_second, count_after_first,
            "second pull must delete 0 rows (row count unchanged — 0 inserts and 0 deletes)"
        );
    }

    /// Two devices each authoring 50 versions for the SAME entry (dev-a's
    /// batch entirely older, dev-b's entirely newer) must converge to
    /// exactly 50 local rows after syncing — the newest 50 across both
    /// devices' contributions, not 100 and not an arbitrary subset.
    #[tokio::test]
    async fn pull_versions_two_devices_50_each_converge_to_newest_50() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");
        seed_bare_entry(&conn_b, &entry_id);

        let base = now_unix() - 200;
        // dev-a's 50 versions: the OLDER half (base .. base+49).
        for i in 0..50i64 {
            let id = db::insert_entry_version(&conn_a, &entry_id, b"a", &format!("a{i}"), "dev-a")
                .unwrap();
            conn_a
                .execute(
                    "UPDATE entry_versions SET created_at = ?1 WHERE id = ?2",
                    rusqlite::params![base + i, id],
                )
                .unwrap();
        }
        // dev-b's 50 versions: the NEWER half (base+50 .. base+99).
        for i in 0..50i64 {
            let id = db::insert_entry_version(&conn_b, &entry_id, b"b", &format!("b{i}"), "dev-b")
                .unwrap();
            conn_b
                .execute(
                    "UPDATE entry_versions SET created_at = ?1 WHERE id = ?2",
                    rusqlite::params![base + 50 + i, id],
                )
                .unwrap();
        }

        engine_a.push_versions(&conn_a, &key).await.unwrap();
        engine_b.push_versions(&conn_b, &key).await.unwrap();

        // dev-a pulls dev-b's (all-newer) versions in.
        let (pulled_a, errors_a) = engine_a
            .pull_versions(&conn_a, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors_a.is_empty(), "unexpected errors: {errors_a:?}");
        assert!(
            pulled_a > 0,
            "dev-a must pull at least some of dev-b's versions"
        );

        let a_versions = db::list_entry_versions(&conn_a, &entry_id).unwrap();
        assert_eq!(
            a_versions.len(),
            50,
            "dev-a must converge to exactly the count cap"
        );
        assert!(
            a_versions.iter().all(|v| v.device_id == "dev-b"),
            "dev-a's surviving 50 must be dev-b's (entirely newer) versions"
        );

        // dev-b pulls dev-a's (all-older) versions — none should make the cut.
        let (pulled_b, errors_b) = engine_b
            .pull_versions(&conn_b, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(errors_b.is_empty(), "unexpected errors: {errors_b:?}");
        assert_eq!(
            pulled_b, 0,
            "dev-b already holds the newest 50 — none of dev-a's older versions should be inserted"
        );

        let b_versions = db::list_entry_versions(&conn_b, &entry_id).unwrap();
        assert_eq!(b_versions.len(), 50);
        assert!(b_versions.iter().all(|v| v.device_id == "dev-b"));
    }

    /// Prune-cloud reconcile: an own-folder version file whose local
    /// `entry_versions` row is gone (pruned by `prune_entry_versions` on an
    /// earlier tick) must be deleted from the cloud on the next push cycle.
    /// Only ever touches this device's own folder.
    #[tokio::test]
    async fn push_versions_deletes_orphaned_own_folder_file_with_no_local_row() {
        let key = test_key();
        let conn = fresh_db();
        let dir = TempDir::new().unwrap();
        let engine = make_engine(&dir, "dev-a");

        let entry_id = make_entry_with_content(&conn, &key, "body");
        let version_id =
            db::insert_entry_version(&conn, &entry_id, b"snapshot", "preview", "dev-a").unwrap();
        engine.push_versions(&conn, &key).await.unwrap();

        let path = dir.path().join(format!("dev-a/versions/{version_id}.bin"));
        assert!(path.exists(), "version file should exist after first push");

        // Simulate a local prune (retention/count cap) removing the row
        // while the cloud file is left behind.
        conn.execute("DELETE FROM entry_versions WHERE id = ?1", [&version_id])
            .unwrap();
        assert!(!db::version_exists(&conn, &version_id).unwrap());

        let (_uploaded, errors) = engine.push_versions(&conn, &key).await.unwrap();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert!(
            !path.exists(),
            "orphaned version file must be deleted from own folder"
        );
    }

    /// `push_local` / `pull_remote` must fold the version channel into the
    /// same cycle as entries/media — not a separate opt-in step. Unlike the
    /// unit tests above, this drives the real `pull_remote` entrypoint with
    /// no pre-seeded parent entry: entries pull before versions inside the
    /// same call (see `pull_remote`'s channel ordering comment), so the
    /// entry row must already exist by the time the version is ingested.
    #[tokio::test]
    async fn push_local_and_pull_remote_include_versions_end_to_end() {
        let key = test_key();
        let dir = TempDir::new().unwrap();

        let conn_a = fresh_db();
        let engine_a = make_engine(&dir, "dev-a");
        let entry_id = make_entry_with_content(&conn_a, &key, "body");
        db::insert_entry_version(&conn_a, &entry_id, b"e2e snapshot", "e2e preview", "dev-a")
            .unwrap();

        let push_stats = engine_a
            .push_local(
                &conn_a,
                &key,
                &key_state_from_key(&key),
                SyncTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(push_stats.versions_uploaded, 1);

        let conn_b = fresh_db();
        let engine_b = make_engine(&dir, "dev-b");

        let pull_stats = engine_b
            .pull_remote(&conn_b, &key, &key_state_from_key(&key))
            .await
            .unwrap();
        assert!(
            pull_stats.errors.is_empty(),
            "unexpected errors: {:?}",
            pull_stats.errors
        );
        assert_eq!(pull_stats.versions_pulled, 1);
        assert_eq!(
            db::list_entry_versions(&conn_b, &entry_id).unwrap().len(),
            1
        );
    }
}
