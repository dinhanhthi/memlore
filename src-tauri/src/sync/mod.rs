//! Sync engine — pure-logic core (Chunk 3b).
//!
//! This module is library-only: a `SyncProvider` trait abstracting the
//! storage backend, payload (de)serialization for entries, JSON metadata
//! manifests, Yjs CRDT merge for content, and LWW merge for metadata.
//!
//! There are no Tauri commands and no provider implementations here — the
//! `LocalSyncProvider` and the `useSync` hook land in Chunk 3c.

pub mod cloud_provider;
pub mod embedding_sync;
pub mod engine;
pub mod entry_sync;
pub mod gdrive_oauth;
pub mod gdrive_provider;
pub mod keyring_v2;
pub mod local_keyring_v2;
pub mod local_provider;
pub mod media_cache;
pub mod media_sync;
pub mod metadata;
pub mod provider;
pub mod recovery;
pub mod rotation;
pub mod safety;
pub mod scheduler;
pub mod sync_control;
pub mod version_sync;

pub use cloud_provider::CloudProvider;
pub use embedding_sync::{
    batch_chunks_for_sync, decrypt_embedding_bytes, decrypt_embedding_bytes_by_fingerprint,
    deserialize_chunk_batch, deserialize_embedding_payload, encrypt_embedding_bytes,
    serialize_chunk_batch, serialize_embedding_payload, EmbeddingChunkVector,
    SyncEmbeddingChunkPayload, EMBEDDING_PAYLOAD_SCHEMA_VERSION, MAX_BATCH_PLAINTEXT_BYTES,
};
pub use engine::{PullStats, PushStats, SyncEngine, SyncSummary, SyncTrigger};
pub use entry_sync::{
    deserialize_payload, merge_yjs_full_state_updates, serialize_payload, SyncEntryPayload,
    MAX_PAYLOAD_BYTES, PAYLOAD_SCHEMA_VERSION,
};
pub use local_provider::LocalSyncProvider;
pub use media_sync::{decrypt_media_bytes, encrypt_media_bytes, fetch_media};
pub use metadata::{
    compute_diff, compute_journal_diff, merge_metadata_lww, ChatPayload, DeviceMetadata,
    EntryMetadata, JournalPayload, JournalSyncDiff, LocationAliasesPayload, SettingsPayload,
    StreakPayload, SyncDiff, SyncMediaItem, SyncedChatMessage, SyncedChatSession,
    SyncedEntrySummary, SyncedJournalSummary, SyncedLocationAlias, SyncedSetting, SyncedTag,
    SyncedTemplate, TagsPayload, TemplatesPayload,
};
pub use provider::{FileKind, SyncError, SyncProvider};
pub use recovery::{
    apply_preserved_device_local_state, checkpoint_sqlite_for_swap,
    clear_cloud_preserving_control_io, cloud_authoritative_begin_staging,
    cloud_authoritative_commit, cloud_authoritative_finalize_after_swap,
    cloud_authoritative_materialize, cloud_authoritative_pull_engine,
    cloud_authoritative_swap_plan, cloud_recovery_generation_from_job,
    collect_preserved_device_local_state, complete_cloud_to_local_recovery_job,
    count_cloud_authoritative_channels, discard_cloud_authoritative_staging,
    estimate_cloud_media_bytes_for_preflight, local_authoritative_preflight,
    local_authoritative_rebuild, local_authoritative_verify_and_finalize,
    open_cloud_authoritative_staging_db, perform_cloud_authoritative_swap,
    read_preserved_device_local_state, rebuild_cloud_authoritative_ownership,
    remap_staging_media_paths, rollback_cloud_authoritative_swap, staging_result_from_job,
    CloudAuthoritativeChannelCount, CloudAuthoritativeCommitError,
    CloudAuthoritativeCommitErrorKind, CloudAuthoritativeCommitOpts,
    CloudAuthoritativeCommitResult, CloudAuthoritativeFinalizeOpts,
    CloudAuthoritativeMaterializeError, CloudAuthoritativeMaterializeErrorKind,
    CloudAuthoritativeMaterializeOpts, CloudAuthoritativeMaterializeResult,
    CloudAuthoritativeStagingError, CloudAuthoritativeStagingErrorKind,
    CloudAuthoritativeStagingOpts, CloudAuthoritativeStagingResult, CloudAuthoritativeSwapPlan,
    LocalAuthoritativeKeyringMaterial, LocalAuthoritativePreflightError,
    LocalAuthoritativePreflightErrorKind, LocalAuthoritativePreflightOpts,
    LocalAuthoritativePreflightResult, LocalAuthoritativeRebuildError,
    LocalAuthoritativeRebuildErrorKind, LocalAuthoritativeRebuildOpts,
    LocalAuthoritativeRebuildResult, LocalAuthoritativeVerifyError,
    LocalAuthoritativeVerifyErrorKind, LocalAuthoritativeVerifyOpts,
    LocalAuthoritativeVerifyResult, PreservedDeviceLocalState, ReadOnlySyncProvider,
    RecoveryAdoptionCounts, SyncRecoveryChannel, SyncRecoveryChannelKind, CLOUD_TO_LOCAL_OPERATION,
    LOCAL_TO_CLOUD_OPERATION, SYNC_RECOVERY_CHANNELS,
};
pub use version_sync::{
    decrypt_version_bytes, deserialize_version_payload, encrypt_version_bytes,
    serialize_version_payload, version_cloud_path, SyncVersionPayload, VersionMetadata,
};
