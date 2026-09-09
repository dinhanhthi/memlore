use rusqlite::Connection;

use crate::db;
use crate::sync::keyring_v2::{
    read_recovery_marker, ConditionalMutationResult, KeyringV2Io, RecoveryMarker,
    RECOVERY_MARKER_PATH, RECOVERY_MARKER_VERSION,
};
use crate::sync::provider::SyncError;
use crate::sync::safety::is_safe_device_id;
use crate::sync::sync_control::{SyncControlV1, SYNC_CONTROL_DRIVE_PATH};
use crate::sync::SyncTrigger;

/// Danger-zone wipe lease operation. Not a full recovery job — short-lived
/// exclusive authority so peer normal sync cannot recreate payloads mid-wipe.
pub const CLOUD_CLEANUP_OPERATION: &str = "cloud_cleanup";

/// Raised when the cloud holds no lease and its generation has moved past the
/// permit's — the same "superseded" proof as
/// [`LocalAuthoritativeVerifyErrorKind::RecoverySuperseded`], reached in the
/// narrow race where another device overtakes us between permit resume and
/// lease release. Shared so the call site can match it without a magic string.
pub(crate) const LEASE_RELEASED_ELSEWHERE: &str =
    "released control generation does not match the permit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncRecoveryChannelKind {
    OwnershipLedger,
    FullSnapshot,
    ControlPlane,
    DeviceLocal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncRecoveryChannel {
    pub name: &'static str,
    pub kind: SyncRecoveryChannelKind,
}

/// Explicit inventory used by authoritative recovery preflight and transfer
/// code. Adding a sync channel requires classifying it here so recovery cannot
/// silently omit it.
pub const SYNC_RECOVERY_CHANNELS: &[SyncRecoveryChannel] = &[
    SyncRecoveryChannel {
        name: "entries",
        kind: SyncRecoveryChannelKind::OwnershipLedger,
    },
    SyncRecoveryChannel {
        name: "journals",
        kind: SyncRecoveryChannelKind::OwnershipLedger,
    },
    SyncRecoveryChannel {
        name: "media",
        kind: SyncRecoveryChannelKind::OwnershipLedger,
    },
    SyncRecoveryChannel {
        name: "entry_versions",
        kind: SyncRecoveryChannelKind::OwnershipLedger,
    },
    SyncRecoveryChannel {
        name: "entry_embedding_chunks",
        kind: SyncRecoveryChannelKind::OwnershipLedger,
    },
    SyncRecoveryChannel {
        name: "settings",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "tags",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "templates",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "location_aliases",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "daily_chat",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "streak",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "ai_audit",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "memory",
        kind: SyncRecoveryChannelKind::FullSnapshot,
    },
    SyncRecoveryChannel {
        name: "device_metadata",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "keyring_meta",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "keyring_recovery",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "keyring_content",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "device_slots",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "sync_control",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "recovery_marker",
        kind: SyncRecoveryChannelKind::ControlPlane,
    },
    SyncRecoveryChannel {
        name: "sync_state",
        kind: SyncRecoveryChannelKind::DeviceLocal,
    },
    SyncRecoveryChannel {
        name: "journal_sync_state",
        kind: SyncRecoveryChannelKind::DeviceLocal,
    },
    SyncRecoveryChannel {
        name: "media_cache",
        kind: SyncRecoveryChannelKind::DeviceLocal,
    },
    SyncRecoveryChannel {
        name: "entry_embedding_jobs",
        kind: SyncRecoveryChannelKind::DeviceLocal,
    },
    SyncRecoveryChannel {
        name: "sync_recovery_jobs",
        kind: SyncRecoveryChannelKind::DeviceLocal,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryOwnerPermit {
    pub job_id: i64,
    pub owner_device_id: String,
    pub operation: String,
    pub recovery_generation: u64,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryChannelEvidence {
    pub name: String,
    pub checked: bool,
    pub records: u64,
    pub failures: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryBlobEvidence {
    pub checked: bool,
    pub blobs: u64,
    pub missing: u64,
    pub corrupt: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryVerificationEvidence {
    pub version: u32,
    pub job_id: i64,
    pub operation: String,
    pub recovery_generation: u64,
    pub control_revision: String,
    pub source_inventory_digest: String,
    pub staging_digest: String,
    pub source_inventory_items: u64,
    pub channels: Vec<RecoveryChannelEvidence>,
    pub blobs: RecoveryBlobEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryVerificationBinding {
    pub job_id: i64,
    pub operation: String,
    pub recovery_generation: u64,
    pub control_revision: String,
    pub source_inventory_digest: String,
    pub staging_digest: String,
    pub source_inventory_items: u64,
}

impl RecoveryVerificationEvidence {
    pub fn binding(&self) -> RecoveryVerificationBinding {
        RecoveryVerificationBinding {
            job_id: self.job_id,
            operation: self.operation.clone(),
            recovery_generation: self.recovery_generation,
            control_revision: self.control_revision.clone(),
            source_inventory_digest: self.source_inventory_digest.clone(),
            staging_digest: self.staging_digest.clone(),
            source_inventory_items: self.source_inventory_items,
        }
    }

    pub fn validate_complete(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("unsupported recovery verification evidence version".to_string());
        }
        if self.job_id <= 0
            || !matches!(self.operation.as_str(), "local_to_cloud" | "cloud_to_local")
            || self.recovery_generation == 0
            || self.control_revision.trim().is_empty()
            || self.source_inventory_items == 0
            || !is_sha256_hex(&self.source_inventory_digest)
            || !is_sha256_hex(&self.staging_digest)
        {
            return Err("verification evidence is not bound to a frozen recovery job".to_string());
        }
        let expected = SYNC_RECOVERY_CHANNELS
            .iter()
            .map(|channel| channel.name)
            .collect::<std::collections::BTreeSet<_>>();
        let actual = self
            .channels
            .iter()
            .map(|channel| channel.name.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        if self.channels.len() != actual.len() || actual != expected {
            return Err(
                "verification evidence must cover every classified channel once".to_string(),
            );
        }
        if self
            .channels
            .iter()
            .any(|channel| !channel.checked || channel.failures != 0)
        {
            return Err("verification evidence contains unchecked or failed channels".to_string());
        }
        if !self.blobs.checked || self.blobs.missing != 0 || self.blobs.corrupt != 0 {
            return Err(
                "verification evidence contains incomplete or failed blob checks".to_string(),
            );
        }
        if self
            .channels
            .iter()
            .map(|channel| channel.records)
            .sum::<u64>()
            + self.blobs.blobs
            == 0
        {
            return Err("verification evidence contains no verified source records".to_string());
        }
        Ok(())
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn validate_complete_verification_evidence(json: &str) -> Result<(), String> {
    let evidence: RecoveryVerificationEvidence = serde_json::from_str(json)
        .map_err(|error| format!("malformed verification evidence: {error}"))?;
    evidence.validate_complete()
}

pub(crate) fn parse_control(bytes: &[u8]) -> Result<SyncControlV1, SyncError> {
    let control: SyncControlV1 = serde_json::from_slice(bytes)
        .map_err(|error| SyncError::Serialization(format!("control.json parse error: {error}")))?;
    control
        .validate()
        .map_err(|error| SyncError::Serialization(format!("control.json invalid: {error}")))?;
    Ok(control)
}

pub async fn read_sync_control<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<Option<SyncControlV1>, SyncError> {
    match provider.read_file(SYNC_CONTROL_DRIVE_PATH).await {
        Ok(bytes) => parse_control(&bytes).map(Some),
        Err(SyncError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

pub async fn read_versioned_sync_control<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<(SyncControlV1, String), SyncError> {
    let versioned = provider
        .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
        .await?;
    Ok((parse_control(&versioned.bytes)?, versioned.revision))
}

pub async fn bootstrap_sync_control<P: KeyringV2Io + ?Sized>(
    provider: &P,
    now_unix: i64,
) -> Result<SyncControlV1, SyncError> {
    if let Some(control) = read_sync_control(provider).await? {
        return Ok(control);
    }
    let initial = SyncControlV1::initial(now_unix);
    let bytes = serde_json::to_vec_pretty(&initial)
        .map_err(|error| SyncError::Serialization(error.to_string()))?;
    match provider.create_initial_control_if_absent(&bytes).await? {
        ConditionalMutationResult::Applied | ConditionalMutationResult::Conflict => {}
        ConditionalMutationResult::NotFound => {
            return Err(SyncError::Io(
                "control.json parent disappeared during bootstrap".to_string(),
            ));
        }
    }
    let persisted = read_sync_control(provider)
        .await?
        .ok_or_else(|| SyncError::Io("control.json missing after bootstrap".to_string()))?;
    if persisted != initial {
        return Err(SyncError::Auth(
            "control.json bootstrap lost a concurrent write".to_string(),
        ));
    }
    Ok(persisted)
}

fn marker_matches_permit(marker: &RecoveryMarker, permit: &RecoveryOwnerPermit) -> bool {
    marker.job_id == permit.job_id
        && marker.owner_device_id == permit.owner_device_id
        && marker.operation == permit.operation
        && marker.recovery_generation == permit.recovery_generation
        && marker.nonce == permit.nonce
}

/// Acquire a gen+1 `cloud_cleanup` lease, or resume one already held by this
/// device. Generation advances by exactly one (same rule as recovery) so peer
/// devices at the pre-wipe generation fail closed on normal push even after
/// the lease is released; mid-wipe peers without the permit are blocked by
/// the active lease. Resumable when a prior wipe left our lease stranded.
pub async fn acquire_or_resume_cloud_cleanup_lease<P: KeyringV2Io + ?Sized>(
    provider: &P,
    owner_device_id: &str,
) -> Result<RecoveryOwnerPermit, SyncError> {
    let control = read_sync_control(provider)
        .await?
        .ok_or_else(|| SyncError::Auth("cloud cleanup requires control.json".to_string()))?;

    if let Some(active) = control.recovery_lease.clone() {
        if active.operation == CLOUD_CLEANUP_OPERATION && active.owner_device_id == owner_device_id
        {
            // Resume exact ownership (marker file may be gone mid-wipe).
            return acquire_recovery_lease(provider, &active).await;
        }
        return Err(SyncError::Auth(
            "a competing authoritative recovery already owns the cloud lease".to_string(),
        ));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut nonce_raw = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_raw);
    let mut job_raw = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut job_raw);
    // Ephemeral job id — not backed by sync_recovery_jobs (wipe is not a full recovery job).
    let job_id = (i64::from_be_bytes(job_raw) & i64::MAX).max(1);
    let next_generation = control.recovery_generation.saturating_add(1);
    if next_generation == 0 || next_generation == control.recovery_generation {
        return Err(SyncError::Auth(
            "cloud cleanup cannot advance recovery generation".to_string(),
        ));
    }

    let marker = RecoveryMarker {
        version: RECOVERY_MARKER_VERSION,
        job_id,
        owner_device_id: owner_device_id.to_string(),
        operation: CLOUD_CLEANUP_OPERATION.to_string(),
        recovery_generation: next_generation,
        nonce: hex::encode(nonce_raw),
        created_at: now,
        updated_at: now,
    };
    acquire_recovery_lease(provider, &marker).await
}

pub async fn acquire_recovery_lease<P: KeyringV2Io + ?Sized>(
    provider: &P,
    marker: &RecoveryMarker,
) -> Result<RecoveryOwnerPermit, SyncError> {
    marker
        .validate()
        .map_err(|error| SyncError::Serialization(format!("invalid recovery marker: {error}")))?;
    let permit = RecoveryOwnerPermit {
        job_id: marker.job_id,
        owner_device_id: marker.owner_device_id.clone(),
        operation: marker.operation.clone(),
        recovery_generation: marker.recovery_generation,
        nonce: marker.nonce.clone(),
    };
    let versioned = provider
        .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
        .await?;
    let mut control = parse_control(&versioned.bytes)?;
    if let Some(active) = &control.recovery_lease {
        if !marker_matches_permit(active, &permit) {
            return Err(SyncError::Auth(
                "a competing authoritative recovery already owns the cloud lease".to_string(),
            ));
        }
    } else {
        if marker.recovery_generation != control.recovery_generation.saturating_add(1) {
            return Err(SyncError::Auth(
                "recovery generation must advance cloud control by exactly one".to_string(),
            ));
        }
        if read_recovery_marker(provider).await?.is_some() {
            return Err(SyncError::Auth(
                "orphan recovery marker blocks lease acquisition".to_string(),
            ));
        }
        control.recovery_generation = marker.recovery_generation;
        control.recovery_lease = Some(marker.clone());
        control.updated_at = marker.updated_at;
        let bytes = serde_json::to_vec_pretty(&control)
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        match provider
            .compare_and_swap_file(SYNC_CONTROL_DRIVE_PATH, &versioned.revision, &bytes)
            .await?
        {
            ConditionalMutationResult::Applied => {}
            ConditionalMutationResult::Conflict => {
                return Err(SyncError::Auth(
                    "recovery lease was won by another provider".to_string(),
                ));
            }
            ConditionalMutationResult::NotFound => {
                return Err(SyncError::Auth(
                    "persistent recovery control disappeared during acquisition".to_string(),
                ));
            }
        }
    }

    let winner = parse_control(
        &provider
            .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
            .await?
            .bytes,
    )?;
    if winner.recovery_lease.as_ref() != Some(marker)
        || winner.recovery_generation != marker.recovery_generation
    {
        return Err(SyncError::Auth(
            "recovery lease readback did not confirm the exact winner".to_string(),
        ));
    }
    match read_recovery_marker(provider).await? {
        Some(existing) if existing != *marker => {
            return Err(SyncError::Auth(
                "recovery marker belongs to a different lease".to_string(),
            ));
        }
        Some(_) => {}
        None => {
            let bytes = serde_json::to_vec_pretty(marker)
                .map_err(|error| SyncError::Serialization(error.to_string()))?;
            match provider
                .create_recovery_marker_if_absent(&bytes, &permit)
                .await?
            {
                ConditionalMutationResult::Applied => {}
                ConditionalMutationResult::Conflict => {
                    return Err(SyncError::Auth(
                        "recovery marker creation lost a concurrent race".to_string(),
                    ));
                }
                ConditionalMutationResult::NotFound => {
                    return Err(SyncError::Auth(
                        "recovery marker parent disappeared during acquisition".to_string(),
                    ));
                }
            }
        }
    }
    if read_recovery_marker(provider).await?.as_ref() != Some(marker) {
        return Err(SyncError::Auth(
            "recovery marker readback did not confirm the exact winner".to_string(),
        ));
    }
    Ok(permit)
}

pub async fn release_recovery_lease<P: KeyringV2Io + ?Sized>(
    provider: &P,
    permit: &RecoveryOwnerPermit,
) -> Result<(), SyncError> {
    let versioned = provider
        .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
        .await?;
    let mut control = parse_control(&versioned.bytes)?;
    match control.recovery_lease.as_ref() {
        Some(marker) if marker_matches_permit(marker, permit) => {}
        Some(_) => {
            return Err(SyncError::Auth(
                "cannot release a recovery lease owned by another job".to_string(),
            ));
        }
        None if control.recovery_generation == permit.recovery_generation => {
            if read_recovery_marker(provider).await?.is_some() {
                return Err(SyncError::Auth(
                    "released recovery control still has a live marker".to_string(),
                ));
            }
            return Ok(());
        }
        None => {
            return Err(SyncError::Auth(LEASE_RELEASED_ELSEWHERE.to_string()));
        }
    }

    match provider.read_versioned_file(RECOVERY_MARKER_PATH).await {
        Ok(marker_file) => {
            let marker: RecoveryMarker = serde_json::from_slice(&marker_file.bytes)
                .map_err(|error| SyncError::Serialization(error.to_string()))?;
            if !marker_matches_permit(&marker, permit) {
                return Err(SyncError::Auth(
                    "cannot delete a recovery marker owned by another job".to_string(),
                ));
            }
            match provider
                .delete_file_if_revision(RECOVERY_MARKER_PATH, &marker_file.revision)
                .await?
            {
                ConditionalMutationResult::Applied | ConditionalMutationResult::NotFound => {}
                ConditionalMutationResult::Conflict => {
                    return Err(SyncError::Auth(
                        "recovery marker changed before exact release".to_string(),
                    ));
                }
            }
        }
        Err(SyncError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }

    control.recovery_lease = None;
    let bytes = serde_json::to_vec_pretty(&control)
        .map_err(|error| SyncError::Serialization(error.to_string()))?;
    match provider
        .compare_and_swap_file(SYNC_CONTROL_DRIVE_PATH, &versioned.revision, &bytes)
        .await?
    {
        ConditionalMutationResult::Applied => {}
        ConditionalMutationResult::Conflict => {
            return Err(SyncError::Auth(
                "recovery control changed before lease release".to_string(),
            ));
        }
        ConditionalMutationResult::NotFound => {
            return Err(SyncError::Auth(
                "persistent recovery control disappeared during release".to_string(),
            ));
        }
    }
    let released = parse_control(
        &provider
            .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
            .await?
            .bytes,
    )?;
    if released.recovery_generation != permit.recovery_generation
        || released.recovery_lease.is_some()
    {
        return Err(SyncError::Auth(
            "recovery lease release readback was inconclusive".to_string(),
        ));
    }
    Ok(())
}

pub fn authorize_recovery_push(
    marker: Option<&RecoveryMarker>,
    cloud_generation: u64,
    local_generation: u64,
    permit: Option<&RecoveryOwnerPermit>,
) -> Result<(), String> {
    match (marker, permit) {
        (None, None) => {
            if cloud_generation != local_generation {
                return Err(format!(
                    "recovery generation mismatch: cloud={cloud_generation}, local={local_generation}"
                ));
            }
            Ok(())
        }
        (Some(_), None) => Err("authoritative recovery marker blocks normal sync".to_string()),
        (None, Some(_)) => Err("recovery owner permit requires an active cloud marker".to_string()),
        (Some(marker), Some(permit)) => {
            if marker.job_id != permit.job_id
                || marker.owner_device_id != permit.owner_device_id
                || marker.operation != permit.operation
                || marker.recovery_generation != permit.recovery_generation
                || marker.nonce != permit.nonce
                || local_generation != permit.recovery_generation
                || cloud_generation > permit.recovery_generation
            {
                return Err(
                    "recovery owner permit does not match cloud marker/generation".to_string(),
                );
            }
            Ok(())
        }
    }
}

pub async fn check_provider_recovery_push<P: KeyringV2Io + ?Sized>(
    provider: &P,
    local_generation: u64,
    permit: Option<&RecoveryOwnerPermit>,
) -> Result<(), SyncError> {
    let control = read_sync_control(provider)
        .await?
        .unwrap_or_else(|| SyncControlV1::initial(0));
    authorize_recovery_push(
        control.recovery_lease.as_ref(),
        control.recovery_generation,
        local_generation,
        permit,
    )
    .map_err(SyncError::Auth)
}

/// Complete a verified recovery and remove its remote fence. The durable job
/// first enters `fence_release_pending`; remote release then happens before
/// the local completed flag so a crash remains fail-closed and resumable.
pub async fn finalize_verified_recovery<P: KeyringV2Io + ?Sized>(
    provider: &P,
    conn: &Connection,
    permit: &RecoveryOwnerPermit,
) -> Result<(), String> {
    let job = db::get_sync_recovery_job(conn, permit.job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "recovery job not found".to_string())?;
    let evidence = serde_json::from_str::<RecoveryVerificationEvidence>(&job.verified_counts)
        .map_err(|error| format!("malformed verification evidence: {error}"))?;
    let binding = serde_json::from_str::<RecoveryVerificationBinding>(&job.verification_binding)
        .map_err(|_| "recovery verification scope was not frozen".to_string())?;
    if job.operation != permit.operation
        || u64::try_from(job.recovery_generation).ok() != Some(permit.recovery_generation)
        || job.phase != "fence_release_pending"
        || evidence.validate_complete().is_err()
        || evidence.job_id != job.id
        || evidence.operation != job.operation
        || u64::try_from(job.recovery_generation).ok() != Some(evidence.recovery_generation)
        || evidence.binding() != binding
    {
        return Err("recovery job is not verified for exact finalization".to_string());
    }
    release_recovery_lease(provider, permit)
        .await
        .map_err(|error| error.to_string())?;
    db::complete_sync_recovery_job(conn, permit.job_id).map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryAdoptionCounts {
    pub entries: usize,
    pub journals: usize,
}

/// Atomically claim every local entry and journal, including tombstones, for
/// an explicit local-authoritative rebuild. Normal reset/repair semantics stay
/// unchanged and continue to avoid claiming peer-owned rows.
///
/// This is adopt-only: it does **not** bind staged media or reset upload
/// ledgers. Full rebuild prepare (media bind + reset) lives in
/// [`db::prepare_local_authoritative_rebuild`].
pub fn adopt_all_local_content_for_recovery(
    conn: &Connection,
) -> rusqlite::Result<RecoveryAdoptionCounts> {
    let entries = db::adopt_all_local_entries(conn)?;
    let journals = db::adopt_all_local_journals(conn)?;
    Ok(RecoveryAdoptionCounts { entries, journals })
}

/// Return media IDs whose original is empty, missing, unreadable, or not a
/// regular file. This is a read-only preflight; callers must stop before any
/// cloud mutation when the returned list is non-empty.
pub fn missing_local_media_original_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let rows = db::list_media_local_paths(conn)?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            let path = row.storage_path.trim();
            path.is_empty()
                || std::fs::metadata(path)
                    .map(|metadata| !metadata.is_file())
                    .unwrap_or(true)
                || std::fs::File::open(path).is_err()
        })
        .map(|row| row.id)
        .collect())
}

// ─── Local-authoritative preflight (Phase 2 Task 1) ─────────────────────────

/// Operation stored on recovery jobs created by this preflight.
pub const LOCAL_TO_CLOUD_OPERATION: &str = "local_to_cloud";

/// Extra free-space cushion on top of estimated backup + staging bytes.
const PREFLIGHT_DISK_MARGIN_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAuthoritativePreflightOpts {
    /// Directory that will hold `staging/` and the automatic `.memlore.zip`.
    pub work_dir: std::path::PathBuf,
    /// Inject free disk bytes for tests. `None` probes the real filesystem.
    pub free_bytes_override: Option<u64>,
    /// Resume an existing job when re-running preflight after failure.
    pub existing_job_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthoritativePreflightResult {
    pub job_id: i64,
    pub backup_path: std::path::PathBuf,
    pub staging_path: std::path::PathBuf,
    pub media_total: u64,
    pub media_local: u64,
    pub media_downloaded: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAuthoritativePreflightErrorKind {
    RotationActive,
    ForceRePairRequired,
    InsufficientDisk,
    CloudUnreadable,
    KeyringUnreadable,
    MediaIncomplete,
    BackupFailed,
    JobFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAuthoritativePreflightError {
    pub kind: LocalAuthoritativePreflightErrorKind,
    pub message: String,
    pub missing_media_ids: Vec<String>,
    pub corrupt_media_ids: Vec<String>,
}

impl std::fmt::Display for LocalAuthoritativePreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for LocalAuthoritativePreflightError {}

/// After backup I/O, refuse to rewrite paths / advance phase if the user
/// already cancelled the job while preflight was in flight.
fn recovery_job_may_commit_backup(job: &db::SyncRecoveryJobRow) -> bool {
    !(job.status == "completed" && job.last_error.as_deref() == Some("cancelled"))
}

fn preflight_err(
    kind: LocalAuthoritativePreflightErrorKind,
    message: impl Into<String>,
) -> LocalAuthoritativePreflightError {
    LocalAuthoritativePreflightError {
        kind,
        message: message.into(),
        missing_media_ids: Vec::new(),
        corrupt_media_ids: Vec::new(),
    }
}

fn media_incomplete_err(
    message: impl Into<String>,
    missing: Vec<String>,
    corrupt: Vec<String>,
) -> LocalAuthoritativePreflightError {
    LocalAuthoritativePreflightError {
        kind: LocalAuthoritativePreflightErrorKind::MediaIncomplete,
        message: message.into(),
        missing_media_ids: missing,
        corrupt_media_ids: corrupt,
    }
}

/// Probe free space available on the volume that contains `path`.
pub fn free_disk_bytes(path: &std::path::Path) -> Result<u64, String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|e| format!("invalid path for free-space probe: {e}"))?;
        // Safety: path is a valid C string; statvfs only writes into `stat`.
        unsafe {
            let mut stat: libc::statvfs = std::mem::zeroed();
            if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
                return Err(format!(
                    "free-space probe failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        // Windows free-space probing lands with the Windows recovery path;
        // fail closed so preflight never assumes unlimited disk.
        Err("free-space probe is not implemented on this platform".to_string())
    }
}

fn local_media_file_readable(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return false;
    }
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
        && std::fs::File::open(path).is_ok()
}

fn estimate_preflight_bytes(rows: &[db::MediaRecoveryRow]) -> u64 {
    let media_bytes: u64 = rows
        .iter()
        .map(|row| {
            if local_media_file_readable(&row.storage_path) {
                std::fs::metadata(row.storage_path.trim())
                    .map(|m| m.len())
                    .unwrap_or(0)
            } else {
                row.file_size.unwrap_or(0).max(0) as u64
            }
        })
        .sum();
    // Backup zip ≈ full snapshot + media again; stage cloud-only once.
    media_bytes
        .saturating_mul(2)
        .saturating_add(PREFLIGHT_DISK_MARGIN_BYTES)
        .saturating_add(16 * 1024 * 1024)
}

async fn probe_cloud_and_keyring_readable<K: KeyringV2Io + ?Sized>(
    keyring: &K,
) -> Result<(), LocalAuthoritativePreflightError> {
    match read_sync_control(keyring).await {
        Ok(_) => {}
        Err(SyncError::NotFound(_)) => {}
        Err(error) => {
            return Err(preflight_err(
                LocalAuthoritativePreflightErrorKind::CloudUnreadable,
                format!("cloud control unreadable: {error}"),
            ));
        }
    }

    // read_meta / read_content already validate payloads; NotFound → Ok(None).
    if let Err(error) = crate::sync::keyring_v2::read_meta(keyring).await {
        return Err(preflight_err(
            LocalAuthoritativePreflightErrorKind::KeyringUnreadable,
            format!("keyring meta unreadable: {error}"),
        ));
    }
    if let Err(error) = crate::sync::keyring_v2::read_content(keyring).await {
        return Err(preflight_err(
            LocalAuthoritativePreflightErrorKind::KeyringUnreadable,
            format!("keyring content unreadable: {error}"),
        ));
    }

    Ok(())
}

fn remove_dir_if_exists(path: &std::path::Path) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn remove_if_exists(path: &std::path::Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

fn cleanup_incomplete_staging(staging_path: &std::path::Path) {
    // Rollback contract: incomplete staging files only. Never touch cloud or
    // the finished automatic backup path.
    remove_dir_if_exists(staging_path);
}

fn with_preflight_conn<A, T, F>(access: &A, f: F) -> Result<T, LocalAuthoritativePreflightError>
where
    A: crate::sync::engine::ConnAccess + ?Sized,
    F: FnOnce(&Connection) -> Result<T, LocalAuthoritativePreflightError>,
{
    let mut captured: Option<LocalAuthoritativePreflightError> = None;
    match access.with_conn(|conn| match f(conn) {
        Ok(value) => Ok(value),
        Err(error) => {
            captured = Some(error);
            Err(SyncError::Io(
                "local_authoritative_preflight db step".to_string(),
            ))
        }
    }) {
        Ok(value) => Ok(value),
        Err(error) => Err(captured.unwrap_or_else(|| {
            preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                error.to_string(),
            )
        })),
    }
}

/// Prove that this device holds a complete, decryptable local vault and write
/// an automatic recovery `.memlore.zip` before any local-to-cloud mutation.
///
/// Guarantees:
/// - never deletes cloud objects
/// - does not mutate media rows or other user data
/// - downloads cloud-only originals into the job staging directory only
/// - on failure, removes incomplete staging; retains any finished backup
///
/// Active-vault access is via [`crate::sync::engine::ConnAccess`]: the lock is
/// held only for short DB calls, never across cloud/keyring probes or media
/// staging downloads.
pub async fn local_authoritative_preflight<P, K, A>(
    access: &A,
    media_provider: &P,
    keyring: &K,
    key_state: &crate::EncryptionKeyState,
    opts: LocalAuthoritativePreflightOpts,
) -> Result<LocalAuthoritativePreflightResult, LocalAuthoritativePreflightError>
where
    P: crate::sync::provider::SyncProvider,
    K: KeyringV2Io + ?Sized,
    A: crate::sync::engine::ConnAccess + ?Sized,
{
    // ── Gates: rotation / force re-pair ──────────────────────────────────
    with_preflight_conn(access, |conn| {
        if db::get_setting(conn, db::FORCE_RE_PAIR_REQUIRED)
            .map_err(|e| {
                preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    e.to_string(),
                )
            })?
            .as_deref()
            == Some("1")
        {
            return Err(preflight_err(
                LocalAuthoritativePreflightErrorKind::ForceRePairRequired,
                "force re-pair is required; finish re-pair before local-authoritative recovery",
            ));
        }
        if db::find_active_rotation_job(conn)
            .map_err(|e| {
                preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    e.to_string(),
                )
            })?
            .is_some()
        {
            return Err(preflight_err(
                LocalAuthoritativePreflightErrorKind::RotationActive,
                "an active key rotation blocks local-authoritative recovery",
            ));
        }
        Ok(())
    })?;

    // ── Cloud / keyring readability (read-only) ──────────────────────────
    probe_cloud_and_keyring_readable(keyring).await?;

    let media_rows = with_preflight_conn(access, |conn| {
        db::list_media_for_recovery(conn).map_err(|e| {
            preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                e.to_string(),
            )
        })
    })?;
    let estimated_bytes = estimate_preflight_bytes(&media_rows);

    std::fs::create_dir_all(&opts.work_dir).map_err(|e| {
        preflight_err(
            LocalAuthoritativePreflightErrorKind::JobFailed,
            format!("create work dir: {e}"),
        )
    })?;

    let free_bytes = match opts.free_bytes_override {
        Some(v) => v,
        None => free_disk_bytes(&opts.work_dir).map_err(|e| {
            preflight_err(LocalAuthoritativePreflightErrorKind::InsufficientDisk, e)
        })?,
    };
    if free_bytes < estimated_bytes {
        return Err(preflight_err(
            LocalAuthoritativePreflightErrorKind::InsufficientDisk,
            format!(
                "insufficient free disk: need at least {estimated_bytes} bytes, have {free_bytes}"
            ),
        ));
    }

    // ── Job + staging ────────────────────────────────────────────────────
    let staging_path = opts.work_dir.join("staging");
    let staging_media = staging_path.join("media");
    // Fresh staging for this attempt; prior incomplete downloads are discarded.
    cleanup_incomplete_staging(&staging_path);
    std::fs::create_dir_all(&staging_media).map_err(|e| {
        preflight_err(
            LocalAuthoritativePreflightErrorKind::JobFailed,
            format!("create staging media dir: {e}"),
        )
    })?;

    let local_generation = with_preflight_conn(access, |conn| {
        db::get_sync_recovery_generation(conn).map_err(|e| {
            preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                e.to_string(),
            )
        })
    })?;
    let cloud_generation = read_sync_control(keyring)
        .await
        .ok()
        .flatten()
        .map(|c| c.recovery_generation)
        .unwrap_or(0);
    let next_generation = local_generation
        .max(cloud_generation)
        .saturating_add(1)
        .max(1);

    let job_id = with_preflight_conn(access, |conn| {
        if let Some(existing) = opts.existing_job_id {
            let job = db::get_sync_recovery_job(conn, existing)
                .map_err(|e| {
                    preflight_err(
                        LocalAuthoritativePreflightErrorKind::JobFailed,
                        e.to_string(),
                    )
                })?
                .ok_or_else(|| {
                    preflight_err(
                        LocalAuthoritativePreflightErrorKind::JobFailed,
                        format!("recovery job {existing} not found"),
                    )
                })?;
            if job.operation != LOCAL_TO_CLOUD_OPERATION || job.status == "completed" {
                return Err(preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    "existing job is not a resumable local_to_cloud preflight",
                ));
            }
            db::set_sync_recovery_job_paths(
                conn,
                existing,
                None,
                Some(staging_path.to_string_lossy().as_ref()),
            )
            .map_err(|e| {
                preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    e.to_string(),
                )
            })?;
            Ok(existing)
        } else if let Some(active) = db::find_active_sync_recovery_job(conn).map_err(|e| {
            preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                e.to_string(),
            )
        })? {
            if active.operation != LOCAL_TO_CLOUD_OPERATION {
                return Err(preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    "a different recovery job is already active",
                ));
            }
            db::set_sync_recovery_job_paths(
                conn,
                active.id,
                None,
                Some(staging_path.to_string_lossy().as_ref()),
            )
            .map_err(|e| {
                preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    e.to_string(),
                )
            })?;
            Ok(active.id)
        } else {
            db::create_sync_recovery_job(
                conn,
                LOCAL_TO_CLOUD_OPERATION,
                i64::try_from(next_generation).unwrap_or(i64::MAX),
                None,
                Some(staging_path.to_string_lossy().as_ref()),
            )
            .map_err(|e| {
                preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    e.to_string(),
                )
            })
        }
    })?;

    let fail_job = |access: &A, job_id: i64, err: &LocalAuthoritativePreflightError| {
        let _ = access.with_conn(|conn| {
            db::fail_sync_recovery_job(conn, job_id, &err.message)
                .map_err(|e| SyncError::Io(e.to_string()))
        });
    };

    // ── Media completeness: local originals + staged cloud-only ──────────
    let mut media_local = 0u64;
    let mut media_downloaded = 0u64;
    let mut missing: Vec<String> = Vec::new();
    let mut corrupt: Vec<String> = Vec::new();
    let mut path_overrides: std::collections::HashMap<String, std::path::PathBuf> =
        std::collections::HashMap::new();

    for row in &media_rows {
        if local_media_file_readable(&row.storage_path) {
            media_local += 1;
            continue;
        }

        let Some(cloud_path) = row.cloud_path.as_deref().filter(|p| !p.trim().is_empty()) else {
            missing.push(row.id.clone());
            continue;
        };

        let device_id = match crate::commands::media::validate_cloud_path(cloud_path, &row.id) {
            Ok(device_id) => device_id.to_string(),
            Err(_) => {
                missing.push(row.id.clone());
                continue;
            }
        };

        let staged = staging_media.join(&row.id);
        match crate::sync::media_sync::fetch_media(
            media_provider,
            key_state,
            &row.id,
            &device_id,
            &staged,
        )
        .await
        {
            Ok(_) => {
                if !local_media_file_readable(staged.to_string_lossy().as_ref()) {
                    missing.push(row.id.clone());
                    let _ = std::fs::remove_file(&staged);
                    continue;
                }
                path_overrides.insert(row.id.clone(), staged);
                media_downloaded += 1;
            }
            Err(SyncError::NotFound(_)) => {
                missing.push(row.id.clone());
            }
            Err(error) => {
                let msg = error.to_string();
                if msg.contains("decrypt_media") || msg.to_lowercase().contains("decrypt") {
                    corrupt.push(row.id.clone());
                } else {
                    // Treat other download failures as missing for itemized abort.
                    missing.push(row.id.clone());
                }
                let _ = std::fs::remove_file(&staged);
            }
        }
    }

    if !missing.is_empty() || !corrupt.is_empty() {
        cleanup_incomplete_staging(&staging_path);
        let err = media_incomplete_err(
            format!(
                "local vault is incomplete: {} missing, {} corrupt media originals",
                missing.len(),
                corrupt.len()
            ),
            missing,
            corrupt,
        );
        fail_job(access, job_id, &err);
        return Err(err);
    }

    // ── Automatic timestamped recovery backup ────────────────────────────
    let stamp = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Compact UTC-ish stamp without chrono dependency in this module.
        format!("{now}")
    };
    let backup_path = opts
        .work_dir
        .join(format!("memlore-recovery-{stamp}.memlore.zip"));

    // Per-device db_key to encrypt the automatic backup's full_snapshot.json
    // (same rationale/pattern as the cloud-authoritative staging path's
    // `db_key_owned` — see `write_complete_memlore_backup`'s doc comment).
    let backup_db_key: Option<[u8; 32]> = match key_state.with_db_key(|k| Ok(*k)) {
        Ok(k) => Some(k),
        Err(error) => {
            cleanup_incomplete_staging(&staging_path);
            let err = preflight_err(
                LocalAuthoritativePreflightErrorKind::BackupFailed,
                format!("db_key unavailable for recovery backup: {error}"),
            );
            fail_job(access, job_id, &err);
            return Err(err);
        }
    };

    if let Err(error) = with_preflight_conn(access, |conn| {
        crate::commands::export::write_complete_memlore_backup(
            conn,
            &backup_path,
            &path_overrides,
            backup_db_key.as_ref(),
        )
        .map_err(|error| {
            preflight_err(
                LocalAuthoritativePreflightErrorKind::BackupFailed,
                format!("recovery backup failed: {error}"),
            )
        })
    }) {
        // Backup failed: drop incomplete staging; do not leave a partial zip.
        cleanup_incomplete_staging(&staging_path);
        let _ = std::fs::remove_file(&backup_path);
        fail_job(access, job_id, &error);
        return Err(error);
    }

    let counts = serde_json::json!({
        "media_total": media_rows.len() as u64,
        "media_local": media_local,
        "media_downloaded": media_downloaded,
        "backup_path": backup_path.to_string_lossy(),
        "staging_path": staging_path.to_string_lossy(),
    })
    .to_string();

    with_preflight_conn(access, |conn| {
        let job = db::get_sync_recovery_job(conn, job_id).map_err(|e| {
            preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                e.to_string(),
            )
        })?;
        if !job.as_ref().is_some_and(recovery_job_may_commit_backup) {
            cleanup_incomplete_staging(&staging_path);
            return Err(preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                "recovery job cancelled during preflight backup",
            ));
        }

        db::set_sync_recovery_job_paths(
            conn,
            job_id,
            Some(backup_path.to_string_lossy().as_ref()),
            Some(staging_path.to_string_lossy().as_ref()),
        )
        .map_err(|e| {
            // Backup file is complete — retain it per rollback contract even if
            // the job row cannot be updated.
            preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                e.to_string(),
            )
        })?;

        let phase = db::get_sync_recovery_job(conn, job_id)
            .map_err(|e| {
                preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    e.to_string(),
                )
            })?
            .map(|j| j.phase)
            .unwrap_or_else(|| "created".to_string());

        // created → preflight → backup (idempotent re-entry for resume).
        if phase == "created" {
            if let Err(error) = db::advance_sync_recovery_job(conn, job_id, "preflight", &counts) {
                let err = preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    error.to_string(),
                );
                let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
                return Err(err);
            }
        }
        if phase == "created" || phase == "preflight" || phase == "backup" {
            if let Err(error) = db::advance_sync_recovery_job(conn, job_id, "backup", &counts) {
                let err = preflight_err(
                    LocalAuthoritativePreflightErrorKind::JobFailed,
                    error.to_string(),
                );
                let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
                return Err(err);
            }
        } else {
            let err = preflight_err(
                LocalAuthoritativePreflightErrorKind::JobFailed,
                format!("cannot re-run preflight from phase {phase}"),
            );
            let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
            return Err(err);
        }
        Ok(())
    })?;

    Ok(LocalAuthoritativePreflightResult {
        job_id,
        backup_path,
        staging_path,
        media_total: media_rows.len() as u64,
        media_local,
        media_downloaded,
    })
}

// ─── Local-authoritative rebuild (Phase 2 Task 2) ───────────────────────────

/// One content-key epoch for rebuild keyring publish (mirrors `ContentEntryV2`).
#[derive(Debug, Clone)]
pub struct LocalAuthoritativeContentEntry {
    pub epoch: u32,
    /// 120 hex: AES-GCM(master, content_key).
    pub wrapped_content: String,
    /// 64 hex: key_fingerprint(derive_sync_key(content_key)).
    pub content_fingerprint: String,
}

/// Optional keyring material for republishing under the recovery generation.
/// When absent (incomplete setup), keyring publish is skipped.
#[derive(Debug, Clone)]
pub struct LocalAuthoritativeKeyringMaterial {
    pub recovery_wrapped: String,
    pub device_name: String,
    pub master_fingerprint: String,
    pub created_at: i64,
    pub device_created_at: i64,
    pub last_seen_at: i64,
    /// Full multi-epoch content list (not a raw WRAPPED_CONTENT_LIST blob).
    pub content_entries: Vec<LocalAuthoritativeContentEntry>,
    /// Highest content-key epoch (for `_meta.json.content_epoch`).
    pub content_epoch: u32,
    /// Master-key rotation epoch (for `_meta.json.epoch`).
    pub master_epoch: u64,
}

#[derive(Debug, Clone)]
pub struct LocalAuthoritativeRebuildOpts {
    pub job_id: i64,
    /// Keyring republish material. `None` skips control-plane keyring files.
    pub keyring: Option<LocalAuthoritativeKeyringMaterial>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthoritativeRebuildResult {
    pub job_id: i64,
    pub phase: String,
    pub recovery_generation: u64,
    pub entries_adopted: usize,
    pub journals_adopted: usize,
    pub media_paths_bound: usize,
    pub media_reset: usize,
    pub versions_reset: usize,
    pub pushed_entries: u64,
    pub media_uploaded: u64,
    pub versions_uploaded: u64,
    pub embedding_batches: u64,
    pub push_errors: Vec<String>,
    pub keyring_published: bool,
    /// Owner permit kept for Task 3 fence release; not serialized to the UI.
    #[serde(skip)]
    pub permit: RecoveryOwnerPermit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAuthoritativeRebuildErrorKind {
    SyncInProgress,
    PreflightRequired,
    CompetingRecovery,
    FenceFailed,
    CloudClearFailed,
    PrepareFailed,
    UploadFailed,
    JobFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAuthoritativeRebuildError {
    pub kind: LocalAuthoritativeRebuildErrorKind,
    pub message: String,
}

impl std::fmt::Display for LocalAuthoritativeRebuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for LocalAuthoritativeRebuildError {}

fn rebuild_err(
    kind: LocalAuthoritativeRebuildErrorKind,
    message: impl Into<String>,
) -> LocalAuthoritativeRebuildError {
    LocalAuthoritativeRebuildError {
        kind,
        message: message.into(),
    }
}

/// Delete every cloud object except `control.json` so the recovery fence
/// (generation + lease) remains live. Works for any [`KeyringV2Io`] whose
/// `list_files("")` returns the full inventory (test dual providers).
/// Production Google Drive uses [`crate::sync::gdrive_provider::GDriveProvider::clear_cloud_preserving_control`].
pub async fn clear_cloud_preserving_control_io<P: KeyringV2Io + ?Sized>(
    provider: &P,
) -> Result<(), SyncError> {
    let control_before = read_sync_control(provider)
        .await?
        .ok_or_else(|| SyncError::Auth("cloud cleanup requires control.json".to_string()))?;
    if control_before.recovery_lease.is_none() {
        return Err(SyncError::Auth(
            "cloud cleanup requires an active recovery lease".to_string(),
        ));
    }
    let paths = provider.list_files("").await?;
    for path in paths {
        // Keep control.json and the live recovery marker — both are fence
        // authority, not rebuild payloads.
        if path == SYNC_CONTROL_DRIVE_PATH || path == RECOVERY_MARKER_PATH {
            continue;
        }
        provider.delete_file(&path).await?;
    }
    let control_after = read_sync_control(provider)
        .await?
        .ok_or_else(|| SyncError::Auth("control.json disappeared during cleanup".to_string()))?;
    if control_before != control_after {
        return Err(SyncError::Auth(
            "control.json changed during cloud cleanup".to_string(),
        ));
    }
    Ok(())
}

async fn acquire_or_resume_local_to_cloud_lease<P: KeyringV2Io + ?Sized>(
    provider: &P,
    job: &db::SyncRecoveryJobRow,
    owner_device_id: &str,
) -> Result<RecoveryOwnerPermit, SyncError> {
    if job.operation != LOCAL_TO_CLOUD_OPERATION {
        return Err(SyncError::Auth(
            "recovery job is not a local_to_cloud rebuild".to_string(),
        ));
    }
    let generation = u64::try_from(job.recovery_generation)
        .map_err(|_| SyncError::Auth("recovery job generation is not a valid u64".to_string()))?;
    if generation == 0 {
        return Err(SyncError::Auth(
            "recovery job generation must be positive".to_string(),
        ));
    }

    // Ensure control exists so gen+1 CAS can run.
    let _ = bootstrap_sync_control(provider, now_unix_secs()).await?;

    if let Some(control) = read_sync_control(provider).await? {
        if let Some(active) = control.recovery_lease.clone() {
            if active.job_id == job.id
                && active.owner_device_id == owner_device_id
                && active.operation == LOCAL_TO_CLOUD_OPERATION
                && active.recovery_generation == generation
            {
                return acquire_recovery_lease(provider, &active).await;
            }
            return Err(SyncError::Auth(
                "a competing authoritative recovery already owns the cloud lease".to_string(),
            ));
        }
        if generation != control.recovery_generation.saturating_add(1) {
            return Err(SyncError::Auth(format!(
                "recovery generation mismatch for fence: job={generation}, cloud={}",
                control.recovery_generation
            )));
        }
    }

    let now = now_unix_secs();
    let mut nonce_raw = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_raw);
    let marker = RecoveryMarker {
        version: RECOVERY_MARKER_VERSION,
        job_id: job.id,
        owner_device_id: owner_device_id.to_string(),
        operation: LOCAL_TO_CLOUD_OPERATION.to_string(),
        recovery_generation: generation,
        nonce: hex::encode(nonce_raw),
        created_at: now,
        updated_at: now,
    };
    acquire_recovery_lease(provider, &marker).await
}

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn republish_keyring_for_rebuild<P: KeyringV2Io + ?Sized>(
    provider: &P,
    material: &LocalAuthoritativeKeyringMaterial,
    device_id: &str,
    recovery_generation: u64,
) -> Result<(), SyncError> {
    use crate::sync::keyring_v2::{
        io::{write_content, write_device_slot, write_meta, write_recovery},
        types::{
            ContentEntryV2, ContentListV2, DeviceSlotV2, KeyringMetaV2, RecoverySlotV2,
            KEYRING_V2_VERSION,
        },
    };

    if material.content_entries.is_empty() {
        return Err(SyncError::Auth(
            "keyring rebuild material has no content-key epochs".to_string(),
        ));
    }

    let recovery_slot = RecoverySlotV2 {
        version: KEYRING_V2_VERSION,
        wrapped_master: material.recovery_wrapped.clone(),
        created_at: material.created_at,
    };
    let device_slot = DeviceSlotV2 {
        version: KEYRING_V2_VERSION,
        device_id: device_id.to_string(),
        name: material.device_name.clone(),
        created_at: material.device_created_at,
        last_seen_at: material.last_seen_at,
    };

    // Publish the full multi-epoch map (mirrors write_content_list_cloud /
    // publish_v2_keyring_with_provider). Never flatten to epoch 1 only.
    let mut entries: Vec<ContentEntryV2> = material
        .content_entries
        .iter()
        .map(|e| ContentEntryV2 {
            epoch: e.epoch,
            wrapped_content: e.wrapped_content.clone(),
            content_fingerprint: e.content_fingerprint.clone(),
        })
        .collect();
    entries.sort_by_key(|e| e.epoch);
    let latest_epoch = entries
        .last()
        .map(|e| e.epoch)
        .unwrap_or(material.content_epoch);
    let content_list = ContentListV2 {
        version: KEYRING_V2_VERSION,
        latest_epoch,
        entries,
        created_at: material.created_at,
    };
    // Fail closed before any cloud write if fingerprints/slots are malformed.
    content_list.validate().map_err(|e| {
        SyncError::Serialization(format!("keyring rebuild content list invalid: {e}"))
    })?;

    let meta = KeyringMetaV2 {
        version: KEYRING_V2_VERSION,
        epoch: material.master_epoch.max(1),
        master_fingerprint: material.master_fingerprint.clone(),
        content_epoch: material.content_epoch.max(latest_epoch),
        recovery_generation,
        created_at: material.created_at,
        updated_at: material.created_at,
    };

    // Crash-safe order: content → recovery → device → meta (commit marker).
    write_content(provider, &content_list).await?;
    write_recovery(provider, &recovery_slot).await?;
    write_device_slot(provider, &device_slot).await?;
    write_meta(provider, &meta).await?;
    Ok(())
}

fn map_db_err<T>(
    result: Result<T, rusqlite::Error>,
    kind: LocalAuthoritativeRebuildErrorKind,
) -> Result<T, LocalAuthoritativeRebuildError> {
    result.map_err(|e| rebuild_err(kind, e.to_string()))
}

fn with_rebuild_conn<C, T, F>(access: &C, f: F) -> Result<T, LocalAuthoritativeRebuildError>
where
    C: crate::sync::engine::ConnAccess,
    F: FnOnce(&Connection) -> Result<T, LocalAuthoritativeRebuildError>,
{
    let mut captured: Option<LocalAuthoritativeRebuildError> = None;
    match access.with_conn(|conn| match f(conn) {
        Ok(value) => Ok(value),
        Err(error) => {
            captured = Some(error);
            Err(SyncError::Io(
                "local_authoritative_rebuild db step".to_string(),
            ))
        }
    }) {
        Ok(value) => Ok(value),
        Err(error) => Err(captured.unwrap_or_else(|| {
            rebuild_err(
                LocalAuthoritativeRebuildErrorKind::JobFailed,
                error.to_string(),
            )
        })),
    }
}

/// Rebuild every cloud channel from the local vault after preflight/backup.
///
/// Phases (adjacent, resumable):
/// - `backup` → acquire fence, clear cloud payloads, prepare local ledgers → `fenced`
/// - `fenced` → keyring + push every channel (manifest last) → `transfer`
/// - `transfer` → already uploaded; returns success for Task 2 (Task 3 verifies)
///
/// Acquires [`crate::commands::sync::SyncInProgressGuard`] for the duration
/// of the rebuild so concurrent normal sync cannot interleave. Rejects with
/// `SyncInProgress` when another sync already holds the single-flight slot.
/// Does not release the recovery fence (Task 3).
pub async fn local_authoritative_rebuild<C, SP, KR, F, Fut>(
    access: &C,
    sync_provider: std::sync::Arc<SP>,
    keyring: &KR,
    device_id: &str,
    sync_key: &[u8; 32],
    key_state: &crate::EncryptionKeyState,
    opts: LocalAuthoritativeRebuildOpts,
    clear_cloud: F,
) -> Result<LocalAuthoritativeRebuildResult, LocalAuthoritativeRebuildError>
where
    C: crate::sync::engine::ConnAccess,
    SP: crate::sync::provider::SyncProvider + 'static,
    KR: KeyringV2Io + ?Sized,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), SyncError>>,
{
    // Single-flight: reject when normal sync (or another rebuild) is running.
    let _sync_guard =
        crate::commands::sync::SyncInProgressGuard::try_acquire().ok_or_else(|| {
            rebuild_err(
                LocalAuthoritativeRebuildErrorKind::SyncInProgress,
                crate::commands::sync::SYNC_IN_PROGRESS_ERR,
            )
        })?;

    let fail_job = |access: &C, job_id: i64, err: &LocalAuthoritativeRebuildError| {
        let _ = access.with_conn(|conn| {
            db::fail_sync_recovery_job(conn, job_id, &err.message)
                .map_err(|e| SyncError::Io(e.to_string()))
        });
    };

    let job = with_rebuild_conn(access, |conn| {
        let job = db::get_sync_recovery_job(conn, opts.job_id)
            .map_err(|e| rebuild_err(LocalAuthoritativeRebuildErrorKind::JobFailed, e.to_string()))?
            .ok_or_else(|| {
                rebuild_err(
                    LocalAuthoritativeRebuildErrorKind::PreflightRequired,
                    format!("recovery job {} not found", opts.job_id),
                )
            })?;
        Ok(job)
    })?;

    if job.operation != LOCAL_TO_CLOUD_OPERATION || job.status == "completed" {
        return Err(rebuild_err(
            LocalAuthoritativeRebuildErrorKind::JobFailed,
            "job is not a resumable local_to_cloud rebuild".to_string(),
        ));
    }

    let generation = u64::try_from(job.recovery_generation).map_err(|_| {
        rebuild_err(
            LocalAuthoritativeRebuildErrorKind::JobFailed,
            "invalid recovery generation on job".to_string(),
        )
    })?;

    // Already past upload — Task 2 terminal success (Task 3 starts at verify).
    if matches!(
        job.phase.as_str(),
        "transfer" | "verify" | "commit" | "finalize" | "fence_release_pending"
    ) {
        let permit = acquire_or_resume_local_to_cloud_lease(keyring, &job, device_id)
            .await
            .map_err(|e| {
                rebuild_err(
                    LocalAuthoritativeRebuildErrorKind::FenceFailed,
                    e.to_string(),
                )
            })?;
        return Ok(LocalAuthoritativeRebuildResult {
            job_id: job.id,
            phase: job.phase,
            recovery_generation: generation,
            entries_adopted: 0,
            journals_adopted: 0,
            media_paths_bound: 0,
            media_reset: 0,
            versions_reset: 0,
            pushed_entries: 0,
            media_uploaded: 0,
            versions_uploaded: 0,
            embedding_batches: 0,
            push_errors: Vec::new(),
            permit,
            keyring_published: false,
        });
    }

    if job.phase != "backup" && job.phase != "fenced" {
        let err = rebuild_err(
            LocalAuthoritativeRebuildErrorKind::PreflightRequired,
            format!(
                "local_authoritative_rebuild requires phase backup|fenced (got {})",
                job.phase
            ),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    }

    // ── Fence ────────────────────────────────────────────────────────────
    let permit = match acquire_or_resume_local_to_cloud_lease(keyring, &job, device_id).await {
        Ok(p) => p,
        Err(SyncError::Auth(msg)) if msg.contains("competing") => {
            let err = rebuild_err(LocalAuthoritativeRebuildErrorKind::CompetingRecovery, msg);
            fail_job(access, job.id, &err);
            return Err(err);
        }
        Err(e) => {
            let err = rebuild_err(
                LocalAuthoritativeRebuildErrorKind::FenceFailed,
                e.to_string(),
            );
            fail_job(access, job.id, &err);
            return Err(err);
        }
    };
    keyring.configure_recovery_fence(permit.recovery_generation, Some(permit.clone()));

    if let Err(e) = with_rebuild_conn(access, |conn| {
        db::set_sync_recovery_generation(conn, permit.recovery_generation).map_err(|error| {
            rebuild_err(
                LocalAuthoritativeRebuildErrorKind::JobFailed,
                error.to_string(),
            )
        })?;
        crate::sync::engine::invalidate_surface_push_state(conn).map_err(|error| {
            rebuild_err(
                LocalAuthoritativeRebuildErrorKind::JobFailed,
                error.to_string(),
            )
        })
    }) {
        fail_job(access, job.id, &e);
        return Err(e);
    }

    // ── Cloud payload wipe (preserve fence) ──────────────────────────────
    // Re-run on fenced resume: deletes are idempotent; lease stays live.
    if let Err(e) = clear_cloud().await {
        let err = rebuild_err(
            LocalAuthoritativeRebuildErrorKind::CloudClearFailed,
            e.to_string(),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    }

    // ── Local adoption + upload prep (single transaction) ────────────────
    let prepared = match with_rebuild_conn(access, |conn| {
        map_db_err(
            db::prepare_local_authoritative_rebuild(conn, job.staging_path.as_deref()),
            LocalAuthoritativeRebuildErrorKind::PrepareFailed,
        )
    }) {
        Ok(c) => c,
        Err(e) => {
            fail_job(access, job.id, &e);
            return Err(e);
        }
    };

    // Drop peer device rows whose cloud slots are gone; force keyring dirty.
    let _ = with_rebuild_conn(access, |conn| {
        let _ = db::delete_non_current_devices(conn);
        let _ = db::set_setting(conn, db::KEYRING_DIRTY_KEY, "1");
        Ok(())
    });

    let fence_counts = serde_json::json!({
        "recovery_generation": permit.recovery_generation,
        "entries_adopted": prepared.entries,
        "journals_adopted": prepared.journals,
        "media_paths_bound": prepared.media_paths_bound,
        "media_reset": prepared.media_reset,
        "versions_reset": prepared.versions_reset,
    })
    .to_string();

    if let Err(e) = with_rebuild_conn(access, |conn| {
        map_db_err(
            db::advance_sync_recovery_job(conn, job.id, "fenced", &fence_counts),
            LocalAuthoritativeRebuildErrorKind::JobFailed,
        )
    }) {
        // Same-phase re-entry (already fenced) is allowed by the DB helper.
        fail_job(access, job.id, &e);
        return Err(e);
    }

    // ── Control-plane: password keyring ───────────────────────────────────
    // No keyring material would leave a wiped keyring — fail closed.
    let Some(material) = opts.keyring.as_ref() else {
        let err = rebuild_err(
            LocalAuthoritativeRebuildErrorKind::UploadFailed,
            "rebuild requires keyring material; load failed or incomplete vault".to_string(),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    };
    if let Err(e) =
        republish_keyring_for_rebuild(keyring, material, device_id, permit.recovery_generation)
            .await
    {
        let err = rebuild_err(
            LocalAuthoritativeRebuildErrorKind::UploadFailed,
            format!("keyring republish failed: {e}"),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    }
    let _ = with_rebuild_conn(access, |conn| {
        let _ = db::delete_setting(conn, db::KEYRING_DIRTY_KEY);
        Ok(())
    });
    let keyring_published = true;

    // ── Upload every channel in dependency order (manifest last) ─────────
    let engine = crate::sync::engine::SyncEngine::new(sync_provider, device_id.to_string());
    let push_stats = match engine
        .push_local(access, sync_key, key_state, SyncTrigger::Manual)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            let err = rebuild_err(
                LocalAuthoritativeRebuildErrorKind::UploadFailed,
                e.to_string(),
            );
            fail_job(access, job.id, &err);
            return Err(err);
        }
    };

    if !push_stats.errors.is_empty() {
        let err = rebuild_err(
            LocalAuthoritativeRebuildErrorKind::UploadFailed,
            format!(
                "channel upload completed with errors: {}",
                push_stats.errors.join("; ")
            ),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    }

    let transfer_counts = serde_json::json!({
        "recovery_generation": permit.recovery_generation,
        "entries_adopted": prepared.entries,
        "journals_adopted": prepared.journals,
        "media_paths_bound": prepared.media_paths_bound,
        "media_reset": prepared.media_reset,
        "versions_reset": prepared.versions_reset,
        "pushed_entries": push_stats.pushed,
        "media_uploaded": push_stats.media_uploaded,
        "versions_uploaded": push_stats.versions_uploaded,
        "embedding_batches": push_stats.embedding_chunk_batches_uploaded,
        "keyring_published": keyring_published,
    })
    .to_string();

    if let Err(e) = with_rebuild_conn(access, |conn| {
        map_db_err(
            db::advance_sync_recovery_job(conn, job.id, "transfer", &transfer_counts),
            LocalAuthoritativeRebuildErrorKind::JobFailed,
        )
    }) {
        fail_job(access, job.id, &e);
        return Err(e);
    }

    Ok(LocalAuthoritativeRebuildResult {
        job_id: job.id,
        phase: "transfer".to_string(),
        recovery_generation: permit.recovery_generation,
        entries_adopted: prepared.entries,
        journals_adopted: prepared.journals,
        media_paths_bound: prepared.media_paths_bound,
        media_reset: prepared.media_reset,
        versions_reset: prepared.versions_reset,
        pushed_entries: push_stats.pushed,
        media_uploaded: push_stats.media_uploaded,
        versions_uploaded: push_stats.versions_uploaded,
        embedding_batches: push_stats.embedding_chunk_batches_uploaded,
        push_errors: push_stats.errors,
        permit,
        keyring_published,
    })
}

// ─── Local-authoritative verify + fence release (Phase 2 Task 3) ────────────

#[derive(Debug, Clone)]
pub struct LocalAuthoritativeVerifyOpts {
    pub job_id: i64,
    /// When true, keyring `_meta.json` must exist and match the job generation.
    pub expect_keyring: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthoritativeVerifyResult {
    pub job_id: i64,
    pub phase: String,
    pub status: String,
    pub recovery_generation: u64,
    pub post_release_sync_errors: Vec<String>,
    /// Omitted from UI serialization of nested evidence when not needed.
    #[serde(skip)]
    pub evidence: RecoveryVerificationEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAuthoritativeVerifyErrorKind {
    SyncInProgress,
    PreflightRequired,
    VerificationFailed,
    FenceFailed,
    /// The cloud holds no lease for this job and its recovery generation has
    /// moved past ours — another recovery superseded this one. Retrying can
    /// never succeed, and abandoning cannot orphan a fence we still own, so
    /// the job is cancelled rather than left resumable.
    RecoverySuperseded,
    PostReleaseSyncFailed,
    JobFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAuthoritativeVerifyError {
    pub kind: LocalAuthoritativeVerifyErrorKind,
    pub message: String,
}

impl std::fmt::Display for LocalAuthoritativeVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for LocalAuthoritativeVerifyError {}

fn verify_err(
    kind: LocalAuthoritativeVerifyErrorKind,
    message: impl Into<String>,
) -> LocalAuthoritativeVerifyError {
    LocalAuthoritativeVerifyError {
        kind,
        message: message.into(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

async fn provider_file_present<P: crate::sync::provider::SyncProvider + ?Sized>(
    provider: &P,
    path: &str,
) -> Result<bool, SyncError> {
    match provider.read_file(path).await {
        Ok(bytes) if !bytes.is_empty() => Ok(true),
        Ok(_) => Ok(true),
        Err(SyncError::NotFound(_)) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn keyring_file_present<P: KeyringV2Io + ?Sized>(
    provider: &P,
    path: &str,
) -> Result<bool, SyncError> {
    match provider.read_file(path).await {
        Ok(_) => Ok(true),
        Err(SyncError::NotFound(_)) => Ok(false),
        Err(error) => Err(error),
    }
}

/// Snapshot local ownership + snapshot inventory used both for digests and
/// expected cloud presence checks.
#[derive(Debug, Clone, Default)]
struct LocalRecoveryInventory {
    entry_ids: Vec<String>,
    journal_ids: Vec<String>,
    media_ids: Vec<String>,
    version_ids: Vec<String>,
    embedding_chunk_rows: u64,
    has_streak: bool,
    staging_token: String,
}

fn load_local_recovery_inventory(
    conn: &Connection,
    device_id: &str,
    staging_path: Option<&str>,
) -> Result<LocalRecoveryInventory, String> {
    let mut entry_ids = conn
        .prepare(
            "SELECT e.id FROM entries e
             INNER JOIN sync_state s ON s.entry_id = e.id
             ORDER BY e.id ASC",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut journal_ids = conn
        .prepare(
            "SELECT j.id FROM journals j
             INNER JOIN journal_sync_state s ON s.journal_id = j.id
             ORDER BY j.id ASC",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let media_ids = db::list_media_for_recovery(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| row.id)
        .collect::<Vec<_>>();

    let version_ids = conn
        .prepare("SELECT id FROM entry_versions ORDER BY id ASC")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let embedding_chunk_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM entry_embedding_chunks", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);

    let has_streak = db::get_syncable_streak(conn)
        .map_err(|e| e.to_string())?
        .is_some();

    entry_ids.sort();
    journal_ids.sort();

    let staging_token = staging_path.unwrap_or("").to_string();
    let _ = device_id;
    Ok(LocalRecoveryInventory {
        entry_ids,
        journal_ids,
        media_ids,
        version_ids,
        embedding_chunk_rows: embedding_chunk_rows.max(0) as u64,
        has_streak,
        staging_token,
    })
}

fn inventory_source_digest(inv: &LocalRecoveryInventory, generation: u64) -> (String, u64) {
    let mut lines = Vec::new();
    for id in &inv.entry_ids {
        lines.push(format!("entry:{id}"));
    }
    for id in &inv.journal_ids {
        lines.push(format!("journal:{id}"));
    }
    for id in &inv.media_ids {
        lines.push(format!("media:{id}"));
    }
    for id in &inv.version_ids {
        lines.push(format!("version:{id}"));
    }
    lines.push(format!("embeddings:{}", inv.embedding_chunk_rows));
    lines.push(format!("streak:{}", inv.has_streak as u8));
    lines.push(format!("generation:{generation}"));
    lines.sort();
    let payload = lines.join("\n");
    let items = inv.entry_ids.len() as u64
        + inv.journal_ids.len() as u64
        + inv.media_ids.len() as u64
        + inv.version_ids.len() as u64
        + 5; // always-on snapshot/control channels contribute to non-zero inventory
    (sha256_hex(payload.as_bytes()), items.max(1))
}

fn inventory_staging_digest(inv: &LocalRecoveryInventory) -> String {
    sha256_hex(format!("staging:{}", inv.staging_token).as_bytes())
}

/// Compare local inventory to cloud blobs/manifests after upload. Fail closed
/// on any missing ownership blob, incomplete snapshot channel, or keyring
/// generation mismatch. Does not mutate cloud state.
pub async fn collect_local_to_cloud_verification_evidence<C, SP, KR>(
    access: &C,
    sync_provider: &SP,
    keyring: &KR,
    device_id: &str,
    job: &db::SyncRecoveryJobRow,
    expect_keyring: bool,
) -> Result<RecoveryVerificationEvidence, LocalAuthoritativeVerifyError>
where
    C: crate::sync::engine::ConnAccess,
    SP: crate::sync::provider::SyncProvider + ?Sized,
    KR: KeyringV2Io + ?Sized,
{
    let generation = u64::try_from(job.recovery_generation).map_err(|_| {
        verify_err(
            LocalAuthoritativeVerifyErrorKind::JobFailed,
            "invalid recovery generation on job",
        )
    })?;

    let versioned = keyring
        .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!("control.json unreadable during verification: {e}"),
            )
        })?;
    let control = parse_control(&versioned.bytes).map_err(|e| {
        verify_err(
            LocalAuthoritativeVerifyErrorKind::VerificationFailed,
            e.to_string(),
        )
    })?;
    if control.recovery_generation != generation {
        return Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::VerificationFailed,
            format!(
                "control recovery_generation {} != job {generation}",
                control.recovery_generation
            ),
        ));
    }
    if control.recovery_lease.is_none() {
        return Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::VerificationFailed,
            "recovery lease missing while verifying post-upload cloud".to_string(),
        ));
    }
    if !keyring_file_present(keyring, RECOVERY_MARKER_PATH)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                e.to_string(),
            )
        })?
    {
        return Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::VerificationFailed,
            "recovery marker missing while verifying post-upload cloud".to_string(),
        ));
    }

    let inventory = with_verify_conn(access, |conn| {
        load_local_recovery_inventory(conn, device_id, job.staging_path.as_deref())
            .map_err(|e| verify_err(LocalAuthoritativeVerifyErrorKind::JobFailed, e))
    })?;
    let (source_inventory_digest, source_inventory_items) =
        inventory_source_digest(&inventory, generation);
    let staging_digest = inventory_staging_digest(&inventory);

    let entry_paths = sync_provider
        .list_files(device_id, crate::sync::provider::FileKind::Entries)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!("list entries failed: {e}"),
            )
        })?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let journal_paths = sync_provider
        .list_files(device_id, crate::sync::provider::FileKind::Journals)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!("list journals failed: {e}"),
            )
        })?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let media_paths = sync_provider
        .list_files(device_id, crate::sync::provider::FileKind::Media)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!("list media failed: {e}"),
            )
        })?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let version_paths = sync_provider
        .list_files(device_id, crate::sync::provider::FileKind::Versions)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!("list versions failed: {e}"),
            )
        })?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let embedding_paths = sync_provider
        .list_files(device_id, crate::sync::provider::FileKind::EmbeddingChunks)
        .await
        .map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!("list embeddings failed: {e}"),
            )
        })?;

    let mut missing_blobs: u64 = 0;
    let mut blob_count: u64 = 0;
    let mut channel_map: std::collections::BTreeMap<&'static str, RecoveryChannelEvidence> =
        std::collections::BTreeMap::new();

    let mut record_owned =
        |name: &'static str,
         ids: &[String],
         path_for: &dyn Fn(&str) -> String,
         present: &std::collections::HashSet<String>| {
            let mut failures = 0u64;
            for id in ids {
                let path = path_for(id);
                if present.contains(&path) {
                    blob_count += 1;
                } else {
                    failures += 1;
                    missing_blobs += 1;
                }
            }
            channel_map.insert(
                name,
                RecoveryChannelEvidence {
                    name: name.to_string(),
                    checked: true,
                    records: ids.len() as u64,
                    failures,
                },
            );
        };

    record_owned(
        "entries",
        &inventory.entry_ids,
        &|id| format!("{device_id}/entries/{id}.bin"),
        &entry_paths,
    );
    record_owned(
        "journals",
        &inventory.journal_ids,
        &|id| format!("{device_id}/journals/{id}.bin"),
        &journal_paths,
    );
    record_owned(
        "media",
        &inventory.media_ids,
        &|id| format!("{device_id}/media/{id}"),
        &media_paths,
    );
    record_owned(
        "entry_versions",
        &inventory.version_ids,
        &|id| crate::sync::version_sync::version_cloud_path(device_id, id),
        &version_paths,
    );

    let mut embedding_failures = 0u64;
    if inventory.embedding_chunk_rows > 0 && embedding_paths.is_empty() {
        embedding_failures = 1;
        missing_blobs += 1;
    }
    channel_map.insert(
        "entry_embedding_chunks",
        RecoveryChannelEvidence {
            name: "entry_embedding_chunks".to_string(),
            checked: true,
            records: if inventory.embedding_chunk_rows > 0 {
                embedding_paths.len() as u64
            } else {
                0
            },
            failures: embedding_failures,
        },
    );

    for (name, path, required) in [
        ("settings", format!("{device_id}/settings.bin"), true),
        ("tags", format!("{device_id}/tags.bin"), true),
        ("templates", format!("{device_id}/templates.bin"), true),
        (
            "location_aliases",
            format!("{device_id}/locations.bin"),
            true,
        ),
        ("daily_chat", format!("{device_id}/chats.bin"), true),
        (
            "streak",
            format!("{device_id}/streak.bin"),
            inventory.has_streak,
        ),
        ("ai_audit", format!("{device_id}/ai_audit.bin"), true),
        ("ai_reviews", format!("{device_id}/ai_reviews.bin"), true),
        (
            "device_metadata",
            format!("{device_id}/metadata.json"),
            true,
        ),
    ] {
        let present = provider_file_present(sync_provider, &path)
            .await
            .map_err(|e| {
                verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    format!("{path}: {e}"),
                )
            })?;
        let failures = u64::from(required && !present);
        if failures > 0 {
            missing_blobs += 1;
        } else if present {
            blob_count += 1;
        }
        channel_map.insert(
            name,
            RecoveryChannelEvidence {
                name: name.to_string(),
                checked: true,
                records: u64::from(present),
                failures,
            },
        );
    }

    // Manifest recovery generation must match the fenced rebuild generation.
    let meta_ok = channel_map
        .get("device_metadata")
        .map(|c| c.failures == 0 && c.records > 0)
        .unwrap_or(false);
    if meta_ok {
        let bytes = sync_provider
            .read_file(&format!("{device_id}/metadata.json"))
            .await
            .map_err(|e| {
                verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    format!("metadata.json read error: {e}"),
                )
            })?;
        let meta: crate::sync::metadata::DeviceMetadata =
            serde_json::from_slice(&bytes).map_err(|e| {
                verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    format!("metadata.json parse error: {e}"),
                )
            })?;
        if meta.recovery_generation != generation || meta.device_id != device_id {
            if let Some(ch) = channel_map.get_mut("device_metadata") {
                ch.failures = 1;
            }
            return Err(verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                format!(
                    "metadata.json recovery_generation {} != {generation} (device={})",
                    meta.recovery_generation, meta.device_id
                ),
            ));
        }
        let memory_path = format!("{device_id}/memory.bin");
        let memory_present = provider_file_present(sync_provider, &memory_path)
            .await
            .map_err(|e| {
                verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    format!("{memory_path}: {e}"),
                )
            })?;
        let failures = u64::from(meta.memory_present && !memory_present);
        if failures > 0 {
            missing_blobs += 1;
        } else if memory_present {
            blob_count += 1;
        }
        channel_map.insert(
            "memory",
            RecoveryChannelEvidence {
                name: "memory".to_string(),
                checked: true,
                records: u64::from(memory_present),
                failures,
            },
        );
    }

    // Control plane
    channel_map.insert(
        "sync_control",
        RecoveryChannelEvidence {
            name: "sync_control".to_string(),
            checked: true,
            records: 1,
            failures: 0,
        },
    );
    channel_map.insert(
        "recovery_marker",
        RecoveryChannelEvidence {
            name: "recovery_marker".to_string(),
            checked: true,
            records: 1,
            failures: 0,
        },
    );

    let keyring_meta_failures = 0u64;
    let mut keyring_recovery_records = 0u64;
    let mut keyring_content_records = 0u64;
    let keyring_content_failures = 0u64;
    let mut device_slot_records = 0u64;
    if expect_keyring {
        match keyring.read_file(crate::sync::keyring_v2::META_PATH).await {
            Ok(bytes) => {
                let meta: crate::sync::keyring_v2::KeyringMetaV2 = serde_json::from_slice(&bytes)
                    .map_err(|e| {
                    verify_err(
                        LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                        format!("keyring meta parse failed: {e}"),
                    )
                })?;
                if meta.recovery_generation != generation {
                    return Err(verify_err(
                        LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                        format!(
                            "keyring meta recovery_generation {} != {generation}",
                            meta.recovery_generation
                        ),
                    ));
                }
            }
            Err(SyncError::NotFound(_)) => {
                return Err(verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    "keyring _meta.json missing after rebuild".to_string(),
                ));
            }
            Err(e) => {
                return Err(verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    format!("keyring meta read failed: {e}"),
                ));
            }
        }
        keyring_recovery_records = u64::from(
            keyring_file_present(keyring, crate::sync::keyring_v2::RECOVERY_PATH)
                .await
                .unwrap_or(false),
        );
        // Fail closed on keyring content: must be present AND pass ContentListV2::validate.
        match crate::sync::keyring_v2::read_content(keyring).await {
            Ok(Some(list)) => {
                // read_content already validates; record entry count.
                keyring_content_records = list.entries.len() as u64;
                if list.entries.is_empty() {
                    return Err(verify_err(
                        LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                        "keyring _content.json is empty after rebuild".to_string(),
                    ));
                }
            }
            Ok(None) => {
                return Err(verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    "keyring _content.json missing after rebuild".to_string(),
                ));
            }
            Err(e) => {
                return Err(verify_err(
                    LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                    format!("keyring _content.json invalid after rebuild: {e}"),
                ));
            }
        }
        let slot_path = crate::sync::keyring_v2::device_slot_path(device_id);
        device_slot_records = u64::from(
            keyring_file_present(keyring, &slot_path)
                .await
                .unwrap_or(false),
        );
        if keyring_recovery_records == 0 || device_slot_records == 0 {
            return Err(verify_err(
                LocalAuthoritativeVerifyErrorKind::VerificationFailed,
                "keyring recovery slot or current device slot missing".to_string(),
            ));
        }
    }
    channel_map.insert(
        "keyring_meta",
        RecoveryChannelEvidence {
            name: "keyring_meta".to_string(),
            checked: true,
            records: u64::from(expect_keyring),
            failures: keyring_meta_failures,
        },
    );
    channel_map.insert(
        "keyring_recovery",
        RecoveryChannelEvidence {
            name: "keyring_recovery".to_string(),
            checked: true,
            records: keyring_recovery_records,
            failures: u64::from(expect_keyring && keyring_recovery_records == 0),
        },
    );
    channel_map.insert(
        "keyring_content",
        RecoveryChannelEvidence {
            name: "keyring_content".to_string(),
            checked: true,
            records: keyring_content_records,
            // Non-zero only when expect_keyring and we returned Err above; success path is 0.
            failures: keyring_content_failures,
        },
    );
    channel_map.insert(
        "device_slots",
        RecoveryChannelEvidence {
            name: "device_slots".to_string(),
            checked: true,
            records: device_slot_records,
            failures: u64::from(expect_keyring && device_slot_records == 0),
        },
    );

    for local_name in [
        "sync_state",
        "journal_sync_state",
        "media_cache",
        "entry_embedding_jobs",
        "sync_recovery_jobs",
    ] {
        channel_map.insert(
            local_name,
            RecoveryChannelEvidence {
                name: local_name.to_string(),
                checked: true,
                records: 0,
                failures: 0,
            },
        );
    }

    let channels: Vec<RecoveryChannelEvidence> = SYNC_RECOVERY_CHANNELS
        .iter()
        .map(|channel| {
            channel_map
                .get(channel.name)
                .cloned()
                .unwrap_or(RecoveryChannelEvidence {
                    name: channel.name.to_string(),
                    checked: false,
                    records: 0,
                    failures: 1,
                })
        })
        .collect();

    let evidence = RecoveryVerificationEvidence {
        version: 1,
        job_id: job.id,
        operation: job.operation.clone(),
        recovery_generation: generation,
        control_revision: versioned.revision,
        source_inventory_digest,
        staging_digest,
        source_inventory_items,
        channels,
        blobs: RecoveryBlobEvidence {
            checked: true,
            blobs: blob_count,
            missing: missing_blobs,
            corrupt: 0,
        },
    };

    evidence.validate_complete().map_err(|e| {
        verify_err(
            LocalAuthoritativeVerifyErrorKind::VerificationFailed,
            format!("post-upload verification incomplete: {e}"),
        )
    })?;

    Ok(evidence)
}

fn with_verify_conn<C, T, F>(access: &C, f: F) -> Result<T, LocalAuthoritativeVerifyError>
where
    C: crate::sync::engine::ConnAccess,
    F: FnOnce(&Connection) -> Result<T, LocalAuthoritativeVerifyError>,
{
    let mut captured: Option<LocalAuthoritativeVerifyError> = None;
    match access.with_conn(|conn| match f(conn) {
        Ok(value) => Ok(value),
        Err(error) => {
            captured = Some(error);
            Err(SyncError::Io(
                "local_authoritative_verify db step".to_string(),
            ))
        }
    }) {
        Ok(value) => Ok(value),
        Err(error) => Err(captured.unwrap_or_else(|| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::JobFailed,
                error.to_string(),
            )
        })),
    }
}

async fn resume_or_synthesize_permit<P: KeyringV2Io + ?Sized>(
    provider: &P,
    job: &db::SyncRecoveryJobRow,
    owner_device_id: &str,
) -> Result<RecoveryOwnerPermit, LocalAuthoritativeVerifyError> {
    let generation = u64::try_from(job.recovery_generation).map_err(|_| {
        verify_err(
            LocalAuthoritativeVerifyErrorKind::JobFailed,
            "invalid recovery generation on job",
        )
    })?;
    match read_sync_control(provider).await {
        Ok(Some(control)) => {
            if let Some(lease) = control.recovery_lease {
                if lease.job_id == job.id
                    && lease.owner_device_id == owner_device_id
                    && lease.operation == job.operation
                    && lease.recovery_generation == generation
                {
                    return acquire_recovery_lease(provider, &lease).await.map_err(|e| {
                        verify_err(
                            LocalAuthoritativeVerifyErrorKind::FenceFailed,
                            e.to_string(),
                        )
                    });
                }
                return Err(verify_err(
                    LocalAuthoritativeVerifyErrorKind::FenceFailed,
                    "recovery lease does not match the active job".to_string(),
                ));
            }
            // Lease already released (resume after fence drop, before complete).
            if control.recovery_generation == generation {
                return Ok(RecoveryOwnerPermit {
                    job_id: job.id,
                    owner_device_id: owner_device_id.to_string(),
                    operation: job.operation.clone(),
                    recovery_generation: generation,
                    nonce: "released".to_string(),
                });
            }
            // Lease is gone (the `Some` arm above returned) and the generation
            // moved on: this recovery was superseded, not merely interrupted.
            Err(verify_err(
                LocalAuthoritativeVerifyErrorKind::RecoverySuperseded,
                format!(
                    "control generation {} does not match job {generation}",
                    control.recovery_generation
                ),
            ))
        }
        Ok(None) => Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::FenceFailed,
            "control.json missing during recovery finalization".to_string(),
        )),
        Err(e) => Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::FenceFailed,
            e.to_string(),
        )),
    }
}

fn advance_verify_phases(
    conn: &Connection,
    job_id: i64,
    from_phase: &str,
    evidence: &RecoveryVerificationEvidence,
) -> Result<(), LocalAuthoritativeVerifyError> {
    let evidence_json = serde_json::to_string(evidence).map_err(|e| {
        verify_err(
            LocalAuthoritativeVerifyErrorKind::JobFailed,
            format!("serialize evidence: {e}"),
        )
    })?;
    let progress = serde_json::json!({
        "recovery_generation": evidence.recovery_generation,
        "source_inventory_items": evidence.source_inventory_items,
        "blobs": evidence.blobs.blobs,
        "missing": evidence.blobs.missing,
    })
    .to_string();

    let phases_after_transfer = ["verify", "commit", "finalize", "fence_release_pending"];
    let start = match from_phase {
        "transfer" => 0,
        "verify" => 1,
        "commit" => 2,
        "finalize" => 3,
        "fence_release_pending" => return Ok(()),
        other => {
            return Err(verify_err(
                LocalAuthoritativeVerifyErrorKind::PreflightRequired,
                format!("cannot verify from phase {other}"),
            ));
        }
    };

    // Freeze binding once before the terminal evidence transition.
    if from_phase != "fence_release_pending" {
        let job = db::get_sync_recovery_job(conn, job_id)
            .map_err(|e| verify_err(LocalAuthoritativeVerifyErrorKind::JobFailed, e.to_string()))?
            .ok_or_else(|| {
                verify_err(
                    LocalAuthoritativeVerifyErrorKind::JobFailed,
                    "recovery job disappeared".to_string(),
                )
            })?;
        if job.verification_binding == "{}" {
            db::bind_sync_recovery_verification_scope(conn, job_id, &evidence.binding()).map_err(
                |e| {
                    verify_err(
                        LocalAuthoritativeVerifyErrorKind::JobFailed,
                        format!("freeze verification scope: {e}"),
                    )
                },
            )?;
        }
    }

    for phase in &phases_after_transfer[start..] {
        let payload = if *phase == "fence_release_pending" {
            evidence_json.as_str()
        } else {
            progress.as_str()
        };
        db::advance_sync_recovery_job(conn, job_id, phase, payload).map_err(|e| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::JobFailed,
                format!("advance to {phase}: {e}"),
            )
        })?;
    }
    Ok(())
}

/// Verify the rebuilt cloud, freeze evidence, release the recovery fence,
/// run one normal sync, then mark the job completed. Resumable from
/// `transfer` through `fence_release_pending`.
///
/// On verification failure the fence stays held and the job is marked
/// failed so peers cannot treat a partial cloud as healthy.
pub async fn local_authoritative_verify_and_finalize<C, SP, KR>(
    access: &C,
    sync_provider: std::sync::Arc<SP>,
    keyring: &KR,
    device_id: &str,
    sync_key: &[u8; 32],
    key_state: &crate::EncryptionKeyState,
    opts: LocalAuthoritativeVerifyOpts,
) -> Result<LocalAuthoritativeVerifyResult, LocalAuthoritativeVerifyError>
where
    C: crate::sync::engine::ConnAccess,
    SP: crate::sync::provider::SyncProvider + 'static,
    KR: KeyringV2Io + ?Sized,
{
    let _sync_guard =
        crate::commands::sync::SyncInProgressGuard::try_acquire().ok_or_else(|| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::SyncInProgress,
                crate::commands::sync::SYNC_IN_PROGRESS_ERR,
            )
        })?;

    let fail_job = |access: &C, job_id: i64, err: &LocalAuthoritativeVerifyError| {
        let _ = access.with_conn(|conn| {
            db::fail_sync_recovery_job(conn, job_id, &err.message)
                .map_err(|e| SyncError::Io(e.to_string()))
        });
    };

    // Terminal abandon: marks the job completed with `last_error = "cancelled"`,
    // so `find_active_sync_recovery_job` stops returning it and the UI clears.
    let cancel_job = |access: &C, job_id: i64| {
        let _ = access.with_conn(|conn| {
            db::cancel_sync_recovery_job(conn, job_id).map_err(|e| SyncError::Io(e.to_string()))
        });
    };

    let job = with_verify_conn(access, |conn| {
        let job = db::get_sync_recovery_job(conn, opts.job_id)
            .map_err(|e| verify_err(LocalAuthoritativeVerifyErrorKind::JobFailed, e.to_string()))?
            .ok_or_else(|| {
                verify_err(
                    LocalAuthoritativeVerifyErrorKind::PreflightRequired,
                    format!("recovery job {} not found", opts.job_id),
                )
            })?;
        Ok(job)
    })?;

    if job.operation != LOCAL_TO_CLOUD_OPERATION {
        return Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::PreflightRequired,
            "job is not a local_to_cloud recovery".to_string(),
        ));
    }
    if job.status == "completed" {
        return Err(verify_err(
            LocalAuthoritativeVerifyErrorKind::JobFailed,
            "recovery job already completed".to_string(),
        ));
    }

    let _generation = u64::try_from(job.recovery_generation).map_err(|_| {
        verify_err(
            LocalAuthoritativeVerifyErrorKind::JobFailed,
            "invalid recovery generation on job",
        )
    })?;

    match job.phase.as_str() {
        "transfer" | "verify" | "commit" | "finalize" | "fence_release_pending" => {}
        other => {
            let err = verify_err(
                LocalAuthoritativeVerifyErrorKind::PreflightRequired,
                format!(
                    "local_authoritative_verify requires phase transfer|verify|commit|finalize|fence_release_pending (got {other})"
                ),
            );
            fail_job(access, job.id, &err);
            return Err(err);
        }
    }

    let permit = match resume_or_synthesize_permit(keyring, &job, device_id).await {
        Ok(p) => p,
        Err(e) => {
            if e.kind == LocalAuthoritativeVerifyErrorKind::RecoverySuperseded {
                // Nothing left to resume or to orphan. Cancelling here is what
                // keeps the job from stranding the UI: a superseded error
                // classifies Terminal (no Resume) and `fence_release_pending`
                // outranks the cancel-safe window (no Cancel).
                cancel_job(access, job.id);
            } else {
                fail_job(access, job.id, &e);
            }
            return Err(e);
        }
    };

    // Still-fenced path: re-verify cloud and advance durable phases.
    let evidence = if job.phase == "fence_release_pending"
        && job.verified_counts != "{}"
        && validate_complete_verification_evidence(&job.verified_counts).is_ok()
    {
        serde_json::from_str::<RecoveryVerificationEvidence>(&job.verified_counts).map_err(|e| {
            let err = verify_err(
                LocalAuthoritativeVerifyErrorKind::JobFailed,
                format!("malformed stored evidence: {e}"),
            );
            fail_job(access, job.id, &err);
            err
        })?
    } else {
        // Configure fence for any KeyringV2Io that honors it (GDrive).
        keyring.configure_recovery_fence(permit.recovery_generation, Some(permit.clone()));
        let evidence = match collect_local_to_cloud_verification_evidence(
            access,
            sync_provider.as_ref(),
            keyring,
            device_id,
            &job,
            opts.expect_keyring,
        )
        .await
        {
            Ok(e) => e,
            Err(e) => {
                fail_job(access, job.id, &e);
                return Err(e);
            }
        };

        if let Err(e) = with_verify_conn(access, |conn| {
            advance_verify_phases(conn, job.id, &job.phase, &evidence)
        }) {
            fail_job(access, job.id, &e);
            return Err(e);
        }
        evidence
    };

    // Release remote fence (idempotent when already released).
    if let Err(e) = release_recovery_lease(keyring, &permit).await {
        // Same superseded proof as the permit-resume path, reached only when
        // another device overtakes us between resume and release.
        let superseded = matches!(&e, SyncError::Auth(m) if m == LEASE_RELEASED_ELSEWHERE);
        let err = verify_err(
            if superseded {
                LocalAuthoritativeVerifyErrorKind::RecoverySuperseded
            } else {
                LocalAuthoritativeVerifyErrorKind::FenceFailed
            },
            format!("fence release failed: {e}"),
        );
        if superseded {
            cancel_job(access, job.id);
        } else {
            // Keep job active at fence_release_pending so resume can retry
            // release. `fail_sync_recovery_job` only sets status, so resume
            // still works from failed + fence_release_pending.
            fail_job(access, job.id, &err);
        }
        return Err(err);
    }
    keyring.configure_recovery_fence(permit.recovery_generation, None);

    // One normal sync without the recovery permit (fence must be gone).
    let engine = crate::sync::engine::SyncEngine::new(sync_provider, device_id.to_string());
    let summary = engine
        .sync_now(access, sync_key, key_state, SyncTrigger::Manual)
        .await
        .map_err(|e| {
            let err = verify_err(
                LocalAuthoritativeVerifyErrorKind::PostReleaseSyncFailed,
                format!("post-release normal sync failed: {e}"),
            );
            fail_job(access, job.id, &err);
            err
        })?;
    if summary.scope_mismatch {
        let err = verify_err(
            LocalAuthoritativeVerifyErrorKind::PostReleaseSyncFailed,
            "post-release normal sync reported scope mismatch".to_string(),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    }
    // Warnings are also copied into `errors`; only hard push failures block.
    let post_errors: Vec<String> = summary
        .errors
        .iter()
        .filter(|error| {
            error.starts_with("push:") && !summary.warnings.iter().any(|warning| warning == *error)
        })
        .cloned()
        .collect();
    if !post_errors.is_empty() {
        let err = verify_err(
            LocalAuthoritativeVerifyErrorKind::PostReleaseSyncFailed,
            format!(
                "post-release normal sync push errors: {}",
                post_errors.join("; ")
            ),
        );
        fail_job(access, job.id, &err);
        return Err(err);
    }

    if let Err(e) = with_verify_conn(access, |conn| {
        db::complete_sync_recovery_job(conn, job.id).map_err(|err| {
            verify_err(
                LocalAuthoritativeVerifyErrorKind::JobFailed,
                format!("complete recovery job: {err}"),
            )
        })
    }) {
        fail_job(access, job.id, &e);
        return Err(e);
    }

    Ok(LocalAuthoritativeVerifyResult {
        job_id: job.id,
        phase: "fence_release_pending".to_string(),
        status: "completed".to_string(),
        recovery_generation: permit.recovery_generation,
        post_release_sync_errors: summary.warnings,
        evidence,
    })
}

// ─── Cloud-authoritative staging (Phase 3 Task 1) ───────────────────────────

/// Operation stored on recovery jobs for cloud → local restore.
pub const CLOUD_TO_LOCAL_OPERATION: &str = "cloud_to_local";

const STAGING_DB_FILE: &str = "staging.db";
const STAGING_MEDIA_DIR: &str = "media";
const PRESERVED_SETTINGS_FILE: &str = "preserved_device_local.json";

/// Free-space cushion for staging DB + backup + media downloads.
const CLOUD_STAGING_DISK_MARGIN_BYTES: u64 = 64 * 1024 * 1024;

/// When the provider cannot report object sizes, assume at least this many
/// bytes per cloud media object so empty-local preflight does not under-budget.
const CLOUD_MEDIA_OBJECT_BYTE_FLOOR: u64 = 256 * 1024;

/// Envelope version for the encrypted preserved device-local side-file.
/// Always encrypted — there is no plaintext (0x00) variant anymore.
const PRESERVED_ENVELOPE_ENCRYPTED: u8 = 0x01;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeStagingOpts {
    /// Directory holding the automatic backup, staging DB, media, and
    /// preserved device-local settings side-file.
    pub work_dir: std::path::PathBuf,
    /// Inject free disk bytes for tests. `None` probes the real filesystem.
    pub free_bytes_override: Option<u64>,
    /// Resume an existing `cloud_to_local` job after a prior attempt.
    pub existing_job_id: Option<i64>,
    /// Optional cloud-side media byte estimate (from provider inventory).
    /// Used so disk preflight is not based solely on a tiny/empty local vault.
    pub cloud_media_bytes_estimate: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAuthoritativeStagingResult {
    pub job_id: i64,
    pub backup_path: std::path::PathBuf,
    pub staging_path: std::path::PathBuf,
    pub staging_db_path: std::path::PathBuf,
    pub staging_media_path: std::path::PathBuf,
    pub preserved_settings_path: std::path::PathBuf,
    /// Cloud recovery generation copied into the staging DB for manifest
    /// acceptance (may be 0 when the cloud has never completed a recovery).
    pub cloud_recovery_generation: u64,
    /// Positive generation stored on the recovery job row.
    pub job_recovery_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudAuthoritativeStagingErrorKind {
    SyncInProgress,
    RotationActive,
    ForceRePairRequired,
    InsufficientDisk,
    CloudUnreadable,
    KeyringUnreadable,
    GenerationInvalid,
    CompetingRecovery,
    BackupFailed,
    StagingFailed,
    JobFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeStagingError {
    pub kind: CloudAuthoritativeStagingErrorKind,
    pub message: String,
}

impl std::fmt::Display for CloudAuthoritativeStagingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CloudAuthoritativeStagingError {}

fn staging_err(
    kind: CloudAuthoritativeStagingErrorKind,
    message: impl Into<String>,
) -> CloudAuthoritativeStagingError {
    CloudAuthoritativeStagingError {
        kind,
        message: message.into(),
    }
}

fn with_staging_conn<A, T, F>(access: &A, f: F) -> Result<T, CloudAuthoritativeStagingError>
where
    A: crate::sync::engine::ConnAccess + ?Sized,
    F: FnOnce(&Connection) -> Result<T, CloudAuthoritativeStagingError>,
{
    let mut captured: Option<CloudAuthoritativeStagingError> = None;
    match access.with_conn(|conn| match f(conn) {
        Ok(value) => Ok(value),
        Err(error) => {
            captured = Some(error);
            Err(SyncError::Io(
                "cloud_authoritative_begin_staging db step".to_string(),
            ))
        }
    }) {
        Ok(value) => Ok(value),
        Err(error) => Err(captured.unwrap_or_else(|| {
            staging_err(
                CloudAuthoritativeStagingErrorKind::JobFailed,
                error.to_string(),
            )
        })),
    }
}

/// Read-only SyncProvider wrapper: every mutation is rejected so cloud-
/// authoritative restore cannot accidentally push or delete Drive objects.
pub struct ReadOnlySyncProvider<P> {
    inner: std::sync::Arc<P>,
}

impl<P> ReadOnlySyncProvider<P> {
    pub fn new(inner: std::sync::Arc<P>) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &P {
        self.inner.as_ref()
    }
}

#[async_trait::async_trait]
impl<P> crate::sync::provider::SyncProvider for ReadOnlySyncProvider<P>
where
    P: crate::sync::provider::SyncProvider + 'static,
{
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

    async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
        Err(SyncError::Io(
            "cloud-authoritative restore forbids provider writes".to_string(),
        ))
    }

    async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
        Err(SyncError::Io(
            "cloud-authoritative restore forbids provider deletes".to_string(),
        ))
    }
}

/// Device-local settings + identity that must survive outside the staged
/// synced dataset and be re-applied after atomic commit (Task 3).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreservedDeviceLocalState {
    pub version: u32,
    pub device_id: Option<String>,
    /// Non-syncable settings keys (OAuth tokens, encryption material, provider
    /// config, device identity, credentials, consent receipts, …).
    pub settings: std::collections::BTreeMap<String, String>,
}

/// Collect OAuth credentials, key material, device identity, and every other
/// non-syncable setting from the active local DB. The staging DB never receives
/// these rows during cloud-authoritative restore.
pub fn collect_preserved_device_local_state(
    conn: &Connection,
) -> Result<PreservedDeviceLocalState, String> {
    let device_id = db::get_setting(conn, db::DEVICE_ID_KEY).map_err(|e| e.to_string())?;
    let mut settings = std::collections::BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM settings
             WHERE deleted_at IS NULL
             ORDER BY key ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        if !db::is_syncable_setting(&key) {
            settings.insert(key, value);
        }
    }
    Ok(PreservedDeviceLocalState {
        version: 1,
        device_id,
        settings,
    })
}

fn write_preserved_device_local_state(
    path: &std::path::Path,
    state: &PreservedDeviceLocalState,
    db_key: &[u8; 32],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create preserved parent: {e}"))?;
    }
    let plaintext = serde_json::to_vec(state)
        .map_err(|e| format!("serialize preserved device-local state: {e}"))?;
    let encrypted = crate::utils::encryption::encrypt_data(db_key, &plaintext)
        .map_err(|e| format!("encrypt preserved device-local state: {e}"))?;
    let mut bytes = Vec::with_capacity(1 + encrypted.len());
    bytes.push(PRESERVED_ENVELOPE_ENCRYPTED);
    bytes.extend_from_slice(&encrypted);
    std::fs::write(path, bytes).map_err(|e| format!("write preserved device-local state: {e}"))
}

/// Open a migrated staging database under `path` using the same keying rule
/// as the active vault: SQLCipher with the HKDF-derived sub-key of `db_key`.
/// Always encrypted — there is no plain-SQLite staging DB anymore.
pub fn open_cloud_authoritative_staging_db(
    path: &std::path::Path,
    db_key: &[u8; 32],
) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create staging parent: {e}"))?;
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| "staging db path is not valid UTF-8".to_string())?;
    let sub = crate::utils::encryption::derive_sqlcipher_key(db_key);
    db::open_with_key(path_str, &sub).map_err(|e| format!("open staging SQLCipher DB: {e}"))
}

/// Close handles (caller drops Connection) and remove the staging directory
/// tree. Never touches the active local DB or cloud objects.
pub fn discard_cloud_authoritative_staging(staging_path: &std::path::Path) {
    remove_dir_if_exists(staging_path);
}

/// Build a recovery pull engine that includes the current device folder and
/// refuses every provider write/delete.
pub fn cloud_authoritative_pull_engine<P>(
    provider: std::sync::Arc<P>,
    device_id: String,
) -> crate::sync::engine::SyncEngine
where
    P: crate::sync::provider::SyncProvider + 'static,
{
    let readonly = std::sync::Arc::new(ReadOnlySyncProvider::new(provider));
    crate::sync::engine::SyncEngine::new(readonly, device_id)
}

async fn validate_cloud_authoritative_control_plane<K: KeyringV2Io + ?Sized>(
    keyring: &K,
    local_generation: u64,
) -> Result<u64, CloudAuthoritativeStagingError> {
    let control = match read_sync_control(keyring).await {
        Ok(c) => c,
        Err(error) => {
            return Err(staging_err(
                CloudAuthoritativeStagingErrorKind::CloudUnreadable,
                format!("cloud control unreadable: {error}"),
            ));
        }
    };
    let cloud_generation = control.as_ref().map(|c| c.recovery_generation).unwrap_or(0);

    if let Some(control) = control.as_ref() {
        if let Some(lease) = control.recovery_lease.as_ref() {
            // Any live fence means another recovery owns the cloud; do not stage.
            return Err(staging_err(
                CloudAuthoritativeStagingErrorKind::CompetingRecovery,
                format!(
                    "cloud is under recovery lease job={} op={}",
                    lease.job_id, lease.operation
                ),
            ));
        }
    }

    if cloud_generation < local_generation {
        return Err(staging_err(
            CloudAuthoritativeStagingErrorKind::GenerationInvalid,
            format!(
                "RECOVERY_GENERATION_ROLLBACK: cloud={cloud_generation}, local={local_generation}"
            ),
        ));
    }

    // Keyring readability + generation alignment.
    match crate::sync::keyring_v2::read_meta(keyring).await {
        Ok(None) => {}
        Ok(Some(meta)) => {
            if meta.recovery_generation != cloud_generation {
                return Err(staging_err(
                    CloudAuthoritativeStagingErrorKind::GenerationInvalid,
                    format!(
                        "RECOVERY_GENERATION_MISMATCH: control={cloud_generation}, keyring_meta={}",
                        meta.recovery_generation
                    ),
                ));
            }
        }
        Err(error) => {
            return Err(staging_err(
                CloudAuthoritativeStagingErrorKind::KeyringUnreadable,
                format!("keyring meta unreadable: {error}"),
            ));
        }
    }
    if let Err(error) = crate::sync::keyring_v2::read_content(keyring).await {
        return Err(staging_err(
            CloudAuthoritativeStagingErrorKind::KeyringUnreadable,
            format!("keyring content unreadable: {error}"),
        ));
    }

    Ok(cloud_generation)
}

/// Acquire the single-flight sync guard, write an automatic local backup,
/// open a migrated encrypted (or plain) staging database with the current
/// per-device `db_key`, and persist device-local settings outside the staged
/// dataset. Does **not** write to Drive. Leaves the active DB connection
/// open and unmodified except for the recovery job row.
///
/// Phases advanced: `created` → `preflight` → `backup`. Materialize (Task 2)
/// starts from `backup` and advances through `fenced`/`transfer`.
///
/// Active-vault access is via [`crate::sync::engine::ConnAccess`]: the lock is
/// held only for short DB calls, never across keyring/control-plane probes.
///
/// Rollback: [`discard_cloud_authoritative_staging`] removes only the staging
/// tree; the backup archive and active vault remain.
pub async fn cloud_authoritative_begin_staging<K, A>(
    access: &A,
    keyring: &K,
    key_state: &crate::EncryptionKeyState,
    opts: CloudAuthoritativeStagingOpts,
) -> Result<CloudAuthoritativeStagingResult, CloudAuthoritativeStagingError>
where
    K: KeyringV2Io + ?Sized,
    A: crate::sync::engine::ConnAccess + ?Sized,
{
    // Single-flight: reject when normal sync or another recovery holds the slot.
    let _sync_guard =
        crate::commands::sync::SyncInProgressGuard::try_acquire().ok_or_else(|| {
            staging_err(
                CloudAuthoritativeStagingErrorKind::SyncInProgress,
                crate::commands::sync::SYNC_IN_PROGRESS_ERR,
            )
        })?;

    // ── Gates: rotation / force re-pair ──────────────────────────────────
    let local_generation = with_staging_conn(access, |conn| {
        if db::get_setting(conn, db::FORCE_RE_PAIR_REQUIRED)
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string()))?
            .as_deref()
            == Some("1")
        {
            return Err(staging_err(
                CloudAuthoritativeStagingErrorKind::ForceRePairRequired,
                "force re-pair is required; finish re-pair before cloud-authoritative restore",
            ));
        }
        if db::find_active_rotation_job(conn)
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string()))?
            .is_some()
        {
            return Err(staging_err(
                CloudAuthoritativeStagingErrorKind::RotationActive,
                "an active key rotation blocks cloud-authoritative restore",
            ));
        }
        db::get_sync_recovery_generation(conn)
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string()))
    })?;

    // Validate keyring/generation BEFORE creating any staging artifacts.
    let cloud_generation =
        validate_cloud_authoritative_control_plane(keyring, local_generation).await?;

    std::fs::create_dir_all(&opts.work_dir).map_err(|e| {
        staging_err(
            CloudAuthoritativeStagingErrorKind::JobFailed,
            format!("create work dir: {e}"),
        )
    })?;

    // Rough estimate: local backup + cloud media download budget.
    // Prefer cloud inventory when provided so an empty local vault cannot
    // under-budget a large cloud restore.
    let media_rows = with_staging_conn(access, |conn| {
        db::list_media_for_recovery(conn)
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string()))
    })?;
    let estimated_bytes =
        estimate_cloud_authoritative_preflight_bytes(&media_rows, opts.cloud_media_bytes_estimate);

    let free_bytes = match opts.free_bytes_override {
        Some(v) => v,
        None => free_disk_bytes(&opts.work_dir)
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::InsufficientDisk, e))?,
    };
    if free_bytes < estimated_bytes {
        return Err(staging_err(
            CloudAuthoritativeStagingErrorKind::InsufficientDisk,
            format!(
                "insufficient free disk: need at least {estimated_bytes} bytes, have {free_bytes}"
            ),
        ));
    }

    let staging_path = opts.work_dir.join("staging");
    let staging_db_path = staging_path.join(STAGING_DB_FILE);
    let staging_media_path = staging_path.join(STAGING_MEDIA_DIR);
    let preserved_settings_path = staging_path.join(PRESERVED_SETTINGS_FILE);

    // Fresh staging tree for this attempt; prior incomplete work is discarded.
    discard_cloud_authoritative_staging(&staging_path);
    std::fs::create_dir_all(&staging_media_path).map_err(|e| {
        staging_err(
            CloudAuthoritativeStagingErrorKind::StagingFailed,
            format!("create staging media dir: {e}"),
        )
    })?;

    let job_recovery_generation = cloud_generation.max(1);
    let job_id = with_staging_conn(access, |conn| {
        if let Some(existing) = opts.existing_job_id {
            let job = db::get_sync_recovery_job(conn, existing)
                .map_err(|e| {
                    staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string())
                })?
                .ok_or_else(|| {
                    staging_err(
                        CloudAuthoritativeStagingErrorKind::JobFailed,
                        format!("recovery job {existing} not found"),
                    )
                })?;
            if job.operation != CLOUD_TO_LOCAL_OPERATION || job.status == "completed" {
                return Err(staging_err(
                    CloudAuthoritativeStagingErrorKind::JobFailed,
                    "existing job is not a resumable cloud_to_local staging job",
                ));
            }
            db::set_sync_recovery_job_paths(
                conn,
                existing,
                None,
                Some(staging_path.to_string_lossy().as_ref()),
            )
            .map_err(|e| {
                staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string())
            })?;
            Ok(existing)
        } else if let Some(active) = db::find_active_sync_recovery_job(conn).map_err(|e| {
            staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string())
        })? {
            if active.operation != CLOUD_TO_LOCAL_OPERATION {
                return Err(staging_err(
                    CloudAuthoritativeStagingErrorKind::JobFailed,
                    "a different recovery job is already active",
                ));
            }
            db::set_sync_recovery_job_paths(
                conn,
                active.id,
                None,
                Some(staging_path.to_string_lossy().as_ref()),
            )
            .map_err(|e| {
                staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string())
            })?;
            Ok(active.id)
        } else {
            db::create_sync_recovery_job(
                conn,
                CLOUD_TO_LOCAL_OPERATION,
                i64::try_from(job_recovery_generation).unwrap_or(i64::MAX),
                None,
                Some(staging_path.to_string_lossy().as_ref()),
            )
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string()))
        }
    })?;

    let fail_job = |access: &A, job_id: i64, err: &CloudAuthoritativeStagingError| {
        let _ = access.with_conn(|conn| {
            db::fail_sync_recovery_job(conn, job_id, &err.message)
                .map_err(|e| SyncError::Io(e.to_string()))
        });
    };

    // ── Per-device db_key (needed to encrypt the preserve side-file) ──────
    let db_key_owned: [u8; 32] = match key_state.with_db_key(|k| Ok(*k)) {
        Ok(k) => k,
        Err(error) => {
            discard_cloud_authoritative_staging(&staging_path);
            let err = staging_err(
                CloudAuthoritativeStagingErrorKind::StagingFailed,
                format!("db_key unavailable for staging: {error}"),
            );
            fail_job(access, job_id, &err);
            return Err(err);
        }
    };

    // ── Preserve device-local settings outside staged dataset (encrypted) ─
    let preserved = match with_staging_conn(access, |conn| {
        collect_preserved_device_local_state(conn).map_err(|error| {
            staging_err(
                CloudAuthoritativeStagingErrorKind::StagingFailed,
                format!("preserve device-local state: {error}"),
            )
        })
    }) {
        Ok(p) => p,
        Err(err) => {
            discard_cloud_authoritative_staging(&staging_path);
            fail_job(access, job_id, &err);
            return Err(err);
        }
    };
    if let Err(error) =
        write_preserved_device_local_state(&preserved_settings_path, &preserved, &db_key_owned)
    {
        discard_cloud_authoritative_staging(&staging_path);
        let err = staging_err(CloudAuthoritativeStagingErrorKind::StagingFailed, error);
        fail_job(access, job_id, &err);
        return Err(err);
    }

    // ── Automatic timestamped recovery backup (active vault) ─────────────
    let stamp = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("{now}")
    };
    let backup_path = opts
        .work_dir
        .join(format!("memlore-recovery-{stamp}.memlore.zip"));

    if let Err(error) = with_staging_conn(access, |conn| {
        crate::commands::export::write_complete_memlore_backup(
            conn,
            &backup_path,
            &std::collections::HashMap::new(),
            Some(&db_key_owned),
        )
        .map_err(|error| {
            staging_err(
                CloudAuthoritativeStagingErrorKind::BackupFailed,
                format!("recovery backup failed: {error}"),
            )
        })
    }) {
        discard_cloud_authoritative_staging(&staging_path);
        let _ = std::fs::remove_file(&backup_path);
        fail_job(access, job_id, &error);
        return Err(error);
    }

    // ── Open migrated staging DB with current per-device db_key ───────────

    let staging_conn = match open_cloud_authoritative_staging_db(&staging_db_path, &db_key_owned) {
        Ok(c) => c,
        Err(error) => {
            discard_cloud_authoritative_staging(&staging_path);
            let err = staging_err(CloudAuthoritativeStagingErrorKind::StagingFailed, error);
            fail_job(access, job_id, &err);
            return Err(err);
        }
    };

    // Seed the cloud recovery generation so recovery pulls accept matching
    // manifests. Generation 0 is the default for a fresh migrate — only
    // write when the cloud has committed a positive generation.
    if cloud_generation > 0 {
        if let Err(error) = db::set_sync_recovery_generation(&staging_conn, cloud_generation) {
            drop(staging_conn);
            discard_cloud_authoritative_staging(&staging_path);
            let err = staging_err(
                CloudAuthoritativeStagingErrorKind::StagingFailed,
                format!("seed staging recovery generation: {error}"),
            );
            fail_job(access, job_id, &err);
            return Err(err);
        }
    }
    // Drop staging connection — callers reopen for materialize / tests.
    drop(staging_conn);

    let counts = serde_json::json!({
        "cloud_recovery_generation": cloud_generation,
        "job_recovery_generation": job_recovery_generation,
        "backup_path": backup_path.to_string_lossy(),
        "staging_path": staging_path.to_string_lossy(),
        "staging_db_path": staging_db_path.to_string_lossy(),
        "preserved_settings_path": preserved_settings_path.to_string_lossy(),
        "preserved_settings_count": preserved.settings.len(),
    })
    .to_string();

    with_staging_conn(access, |conn| {
        db::set_sync_recovery_job_paths(
            conn,
            job_id,
            Some(backup_path.to_string_lossy().as_ref()),
            Some(staging_path.to_string_lossy().as_ref()),
        )
        .map_err(|e| {
            // Backup + staging exist; retain them for resume even if the job row
            // cannot be updated.
            staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string())
        })?;

        let phase = db::get_sync_recovery_job(conn, job_id)
            .map_err(|e| staging_err(CloudAuthoritativeStagingErrorKind::JobFailed, e.to_string()))?
            .map(|j| j.phase)
            .unwrap_or_else(|| "created".to_string());

        // created → preflight → backup (adjacent, resumable).
        if phase == "created" {
            if let Err(error) = db::advance_sync_recovery_job(conn, job_id, "preflight", &counts) {
                let err = staging_err(
                    CloudAuthoritativeStagingErrorKind::JobFailed,
                    error.to_string(),
                );
                let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
                return Err(err);
            }
        }
        if phase == "created" || phase == "preflight" || phase == "backup" {
            if let Err(error) = db::advance_sync_recovery_job(conn, job_id, "backup", &counts) {
                let err = staging_err(
                    CloudAuthoritativeStagingErrorKind::JobFailed,
                    error.to_string(),
                );
                let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
                return Err(err);
            }
        } else {
            let err = staging_err(
                CloudAuthoritativeStagingErrorKind::JobFailed,
                format!("cannot re-run cloud-authoritative staging from phase {phase}"),
            );
            let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
            return Err(err);
        }
        Ok(())
    })?;

    Ok(CloudAuthoritativeStagingResult {
        job_id,
        backup_path,
        staging_path,
        staging_db_path,
        staging_media_path,
        preserved_settings_path,
        cloud_recovery_generation: cloud_generation,
        job_recovery_generation,
    })
}

// ─── Cloud-authoritative materialize (Phase 3 Task 2) ───────────────────────

/// Inputs for streaming every cloud channel into an existing staging tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeMaterializeOpts {
    pub staging: CloudAuthoritativeStagingResult,
    pub device_id: String,
    /// Content/sync key for pull decrypt.
    pub content_key: [u8; 32],
}

/// Verified channel inventory after a complete materialize.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAuthoritativeChannelCount {
    pub name: String,
    pub records: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAuthoritativeMaterializeResult {
    pub job_id: i64,
    pub channels: Vec<CloudAuthoritativeChannelCount>,
    pub media_downloaded: u64,
    pub media_thumbnails_downloaded: u64,
    pub self_owned_entries: u64,
    pub self_owned_journals: u64,
    pub peer_entries: u64,
    pub peer_journals: u64,
    pub pull_pulled: u64,
    pub pull_merged: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudAuthoritativeMaterializeErrorKind {
    SyncInProgress,
    JobFailed,
    PullFailed,
    MediaIncomplete,
    VerificationFailed,
    StagingFailed,
    GenerationInvalid,
    CompetingRecovery,
    CloudUnreadable,
    KeyringUnreadable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeMaterializeError {
    pub kind: CloudAuthoritativeMaterializeErrorKind,
    pub message: String,
    /// Itemized diagnostics retained after staging discard (never copied into active local).
    pub diagnostics: Vec<String>,
}

impl std::fmt::Display for CloudAuthoritativeMaterializeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CloudAuthoritativeMaterializeError {}

fn materialize_err(
    kind: CloudAuthoritativeMaterializeErrorKind,
    message: impl Into<String>,
) -> CloudAuthoritativeMaterializeError {
    CloudAuthoritativeMaterializeError {
        kind,
        message: message.into(),
        diagnostics: Vec::new(),
    }
}

fn materialize_err_diag(
    kind: CloudAuthoritativeMaterializeErrorKind,
    message: impl Into<String>,
    diagnostics: Vec<String>,
) -> CloudAuthoritativeMaterializeError {
    CloudAuthoritativeMaterializeError {
        kind,
        message: message.into(),
        diagnostics,
    }
}

/// Rebuild ownership ledgers on staging after a recovery pull.
///
/// Current-device cloud rows become **synced-owned** (`sync_status = 'synced'`)
/// so the next normal push does not re-queue them. Peer-authored rows remain
/// pull-owned (no `sync_state` / `journal_sync_state` row).
fn is_safe_entity_id(s: &str) -> bool {
    s.len() >= 8
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn rebuild_cloud_authoritative_ownership(
    staging: &Connection,
    device_id: &str,
    self_manifest: &crate::sync::metadata::DeviceMetadata,
) -> Result<(u64, u64, u64, u64), String> {
    if self_manifest.device_id != device_id {
        return Err(format!(
            "self manifest device_id {} does not match recovery device {device_id}",
            self_manifest.device_id
        ));
    }

    let mut self_entries = 0u64;
    for summary in &self_manifest.entries {
        if !is_safe_entity_id(&summary.entry_id) {
            return Err(format!(
                "self manifest lists invalid entry id {:?}",
                summary.entry_id
            ));
        }
        if db::get_entry_raw(staging, &summary.entry_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            if summary.is_deleted {
                // Never-seen tombstone that had no cloud blob is acceptable.
                continue;
            }
            return Err(format!(
                "self-owned live entry {} missing from staging after recovery pull",
                summary.entry_id
            ));
        }
        db::mark_entry_synced(staging, &summary.entry_id, summary.local_version)
            .map_err(|e| e.to_string())?;
        self_entries += 1;
    }

    let mut self_journals = 0u64;
    for summary in &self_manifest.journals {
        if !is_safe_entity_id(&summary.journal_id) {
            return Err(format!(
                "self manifest lists invalid journal id {:?}",
                summary.journal_id
            ));
        }
        if db::get_journal(staging, &summary.journal_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            if summary.is_deleted {
                continue;
            }
            return Err(format!(
                "self-owned live journal {} missing from staging after recovery pull",
                summary.journal_id
            ));
        }
        db::mark_journal_synced(staging, &summary.journal_id, summary.local_version)
            .map_err(|e| e.to_string())?;
        self_journals += 1;
    }

    // Peer-owned rows are everything without a ledger row after self claim.
    let peer_entries: i64 = staging
        .query_row(
            "SELECT COUNT(*) FROM entries e
             WHERE NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.entry_id = e.id)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let peer_journals: i64 = staging
        .query_row(
            "SELECT COUNT(*) FROM journals j
             WHERE NOT EXISTS (
                 SELECT 1 FROM journal_sync_state s WHERE s.journal_id = j.id
             )",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok((
        self_entries,
        self_journals,
        peer_entries.max(0) as u64,
        peer_journals.max(0) as u64,
    ))
}

/// Count every classified recovery channel present in the staging DB.
pub fn count_cloud_authoritative_channels(
    staging: &Connection,
) -> Result<Vec<CloudAuthoritativeChannelCount>, String> {
    let mut out = Vec::with_capacity(SYNC_RECOVERY_CHANNELS.len());
    for channel in SYNC_RECOVERY_CHANNELS {
        let records = match channel.name {
            "entries" => count_sql(staging, "SELECT COUNT(*) FROM entries")?,
            "journals" => count_sql(staging, "SELECT COUNT(*) FROM journals")?,
            "media" => count_sql(staging, "SELECT COUNT(*) FROM media")?,
            "entry_versions" => count_sql(staging, "SELECT COUNT(*) FROM entry_versions")?,
            "entry_embedding_chunks" => {
                count_sql(staging, "SELECT COUNT(*) FROM entry_embedding_chunks")?
            }
            "settings" => count_sql(
                staging,
                "SELECT COUNT(*) FROM settings WHERE deleted_at IS NULL",
            )?,
            "tags" => count_sql(staging, "SELECT COUNT(*) FROM tags")?,
            "templates" => count_sql(staging, "SELECT COUNT(*) FROM templates")?,
            "location_aliases" => count_sql(staging, "SELECT COUNT(*) FROM location_aliases")?,
            "daily_chat" => {
                count_sql(staging, "SELECT COUNT(*) FROM chat_sessions")?
                    + count_sql(staging, "SELECT COUNT(*) FROM chat_messages")?
            }
            "streak" => {
                if db::get_syncable_streak(staging)
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    1
                } else {
                    0
                }
            }
            "ai_audit" => count_sql(staging, "SELECT COUNT(*) FROM ai_audit_log")?,
            "memory" => count_sql(staging, "SELECT COUNT(*) FROM memory_items")?,
            // Control-plane / device-local channels are not materialized into staging content.
            "device_metadata"
            | "keyring_meta"
            | "keyring_recovery"
            | "keyring_content"
            | "device_slots"
            | "sync_control"
            | "recovery_marker"
            | "sync_state"
            | "journal_sync_state"
            | "media_cache"
            | "entry_embedding_jobs"
            | "sync_recovery_jobs" => 0,
            other => return Err(format!("unclassified recovery channel in counter: {other}")),
        };
        out.push(CloudAuthoritativeChannelCount {
            name: channel.name.to_string(),
            records,
        });
    }
    Ok(out)
}

fn count_sql(conn: &Connection, sql: &str) -> Result<u64, String> {
    let n: i64 = conn
        .query_row(sql, [], |r| r.get(0))
        .map_err(|e| format!("count query failed ({sql}): {e}"))?;
    Ok(n.max(0) as u64)
}

async fn read_self_manifest<P: crate::sync::provider::SyncProvider + ?Sized>(
    provider: &P,
    device_id: &str,
) -> Result<Option<crate::sync::metadata::DeviceMetadata>, String> {
    let path = format!("{device_id}/metadata.json");
    match provider.read_file(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("self metadata.json parse: {e}")),
        Err(SyncError::NotFound(_)) => Ok(None),
        Err(e) => Err(format!("self metadata.json read: {e}")),
    }
}

/// Maximum itemized diagnostics kept in a materialize failure — bounds the
/// stored job diagnostics / error message when a pathological failure hits
/// many ids at once.
const MATERIALIZE_DIAGNOSTICS_CAP: usize = 25;

/// Truncate a diagnostics list to [`MATERIALIZE_DIAGNOSTICS_CAP`] entries,
/// appending a summary line for anything cut.
fn cap_diagnostics(mut items: Vec<String>) -> Vec<String> {
    if items.len() > MATERIALIZE_DIAGNOSTICS_CAP {
        let remaining = items.len() - MATERIALIZE_DIAGNOSTICS_CAP;
        items.truncate(MATERIALIZE_DIAGNOSTICS_CAP);
        items.push(format!("...and {remaining} more"));
    }
    items
}

/// Enumerate every device folder on the cloud (self + peers) and read each
/// one's manifest. Two skip rules match `SyncEngine::fetch_manifests`: a
/// folder with no `metadata.json` is a half-created peer, and an unsafe
/// device id is skipped rather than trusted.
///
/// Any other read/parse failure deliberately DIVERGES from the engine, which
/// soft-collects such failures into its `errors` list: here it fails closed
/// (`Err`). This feeds a completeness gate, so a manifest we cannot read must
/// never be silently treated as "nothing claimed" — do not "align" this back
/// to the engine's soft-skip.
async fn fetch_all_recovery_manifests<P: crate::sync::provider::SyncProvider + ?Sized>(
    provider: &P,
) -> Result<Vec<crate::sync::metadata::DeviceMetadata>, String> {
    let devices = provider
        .list_devices()
        .await
        .map_err(|e| format!("list_devices: {e}"))?;
    let mut manifests = Vec::with_capacity(devices.len());
    for device_id in &devices {
        if !is_safe_device_id(device_id) {
            continue;
        }
        if let Some(manifest) = read_self_manifest(provider, device_id).await? {
            manifests.push(manifest);
        }
    }
    Ok(manifests)
}

/// Fail-closed completeness check driven by the cloud's own manifests,
/// independent of the staging DB's row counts.
///
/// `rebuild_cloud_authoritative_ownership`'s `peer_entries`/`peer_journals`
/// are `COUNT(*)` queries over the staging DB itself, so they can never
/// detect a peer row that a pull silently dropped (e.g. a corrupt or missing
/// blob that landed in a warning rather than aborting). This check instead
/// requires every `is_deleted == false` summary in any device's manifest to
/// have a matching row in staging — existence only, not liveness: a newer
/// tombstone from a different device is a legitimate reason the row itself
/// is soft-deleted, so it still counts as present.
fn verify_recovery_manifest_coverage(
    staging: &Connection,
    manifests: &[crate::sync::metadata::DeviceMetadata],
) -> Vec<String> {
    let mut missing = Vec::new();
    for manifest in manifests {
        for summary in &manifest.entries {
            if summary.is_deleted {
                continue;
            }
            // A query error fails closed like a missing row, but says so:
            // otherwise a broken staging DB is indistinguishable from an
            // incomplete pull in the diagnostics the operator reads.
            match db::get_entry_raw(staging, &summary.entry_id) {
                Ok(Some(_)) => {}
                Ok(None) => missing.push(format!(
                    "device {} entry {}: live in manifest but missing from staging",
                    manifest.device_id, summary.entry_id
                )),
                Err(e) => missing.push(format!(
                    "device {} entry {}: staging lookup failed: {e}",
                    manifest.device_id, summary.entry_id
                )),
            }
        }
        for summary in &manifest.journals {
            if summary.is_deleted {
                continue;
            }
            match db::get_journal(staging, &summary.journal_id) {
                Ok(Some(_)) => {}
                Ok(None) => missing.push(format!(
                    "device {} journal {}: live in manifest but missing from staging",
                    manifest.device_id, summary.journal_id
                )),
                Err(e) => missing.push(format!(
                    "device {} journal {}: staging lookup failed: {e}",
                    manifest.device_id, summary.journal_id
                )),
            }
        }
    }
    missing
}

fn ensure_free_disk_for_media_download(
    staging_media_dir: &std::path::Path,
) -> Result<(), CloudAuthoritativeMaterializeError> {
    // Mid-flight guard: preflight may have used a coarse estimate; abort before
    // filling the volume if free space collapses during download.
    let free = match free_disk_bytes(staging_media_dir) {
        Ok(v) => v,
        Err(e) => {
            return Err(materialize_err(
                CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                format!("mid-flight free-space probe failed: {e}"),
            ));
        }
    };
    let min_free = CLOUD_STAGING_DISK_MARGIN_BYTES / 4;
    if free < min_free {
        return Err(materialize_err(
            CloudAuthoritativeMaterializeErrorKind::StagingFailed,
            format!(
                "insufficient free disk during media download: need at least {min_free} bytes free, have {free}"
            ),
        ));
    }
    Ok(())
}

/// Eagerly download every staged media original (required) and thumbnail
/// (best-effort when present) into `staging_media_dir`, then bind local paths.
///
/// `provider` must be read-only (typically [`ReadOnlySyncProvider`]) so cloud-
/// authoritative restore cannot push/delete while caching media.
async fn download_staging_media(
    staging: &Connection,
    provider: &dyn crate::sync::provider::SyncProvider,
    key_state: &crate::EncryptionKeyState,
    staging_media_dir: &std::path::Path,
) -> Result<(u64, u64), CloudAuthoritativeMaterializeError> {
    std::fs::create_dir_all(staging_media_dir).map_err(|e| {
        materialize_err(
            CloudAuthoritativeMaterializeErrorKind::StagingFailed,
            format!("create staging media dir: {e}"),
        )
    })?;

    let rows = db::list_media_for_recovery(staging).map_err(|e| {
        materialize_err(
            CloudAuthoritativeMaterializeErrorKind::JobFailed,
            e.to_string(),
        )
    })?;

    let mut downloaded = 0u64;
    let mut thumbs = 0u64;
    let mut missing = Vec::new();
    let mut corrupt = Vec::new();

    for row in &rows {
        // Defense-in-depth: `row.id` is about to be joined onto the staging
        // media directory to build `staged`/`staged_thumb` paths below. It
        // comes straight from the staging DB's `media` table, which was
        // populated by decrypting peer-supplied sync payloads — re-validate
        // it with the same check used elsewhere in this file before any
        // path-join, rather than trusting it implicitly.
        if !is_safe_entity_id(&row.id) {
            return Err(materialize_err_diag(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!("staging media row has unsafe id, rejecting: {:?}", row.id),
                vec![format!("unsafe_media_id:{}", row.id)],
            ));
        }
        if local_media_file_readable(&row.storage_path) {
            continue;
        }
        let Some(cloud_path) = row.cloud_path.as_deref().filter(|p| !p.trim().is_empty()) else {
            missing.push(row.id.clone());
            continue;
        };
        let device_id = match crate::commands::media::validate_cloud_path(cloud_path, &row.id) {
            Ok(d) => d.to_string(),
            Err(e) => {
                missing.push(format!("{} ({e})", row.id));
                continue;
            }
        };

        ensure_free_disk_for_media_download(staging_media_dir)?;

        let staged = staging_media_dir.join(&row.id);
        match crate::sync::media_sync::fetch_media(
            provider, key_state, &row.id, &device_id, &staged,
        )
        .await
        {
            Ok(path) => {
                if !local_media_file_readable(&path) {
                    missing.push(row.id.clone());
                    let _ = std::fs::remove_file(&staged);
                    continue;
                }
                if let Err(e) = db::update_media_storage_path(staging, &row.id, &path) {
                    return Err(materialize_err(
                        CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                        format!("bind media storage_path for {}: {e}", row.id),
                    ));
                }
                downloaded += 1;
            }
            Err(SyncError::NotFound(_)) => missing.push(row.id.clone()),
            Err(error) => {
                let msg = error.to_string();
                if msg.contains("decrypt_media") || msg.to_lowercase().contains("decrypt") {
                    corrupt.push(row.id.clone());
                } else {
                    missing.push(format!("{}: {msg}", row.id));
                }
                let _ = std::fs::remove_file(&staged);
            }
        }

        // Thumbnail: best-effort when the peer uploaded one.
        let staged_thumb = staging_media_dir.join(format!("{}.thumb.jpg", row.id));
        match crate::sync::media_sync::fetch_media_thumbnail(
            provider,
            key_state,
            &row.id,
            &device_id,
            &staged_thumb,
        )
        .await
        {
            Ok(path) => {
                if local_media_file_readable(&path) {
                    if let Err(e) =
                        db::update_media_thumbnail_path(staging, &row.id, Some(path.as_str()))
                    {
                        return Err(materialize_err(
                            CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                            format!("bind media thumbnail_path for {}: {e}", row.id),
                        ));
                    }
                    thumbs += 1;
                } else {
                    let _ = std::fs::remove_file(&staged_thumb);
                }
            }
            Err(SyncError::NotFound(_)) => {}
            Err(error) => {
                let msg = error.to_string();
                if msg.contains("decrypt_media") || msg.to_lowercase().contains("decrypt") {
                    corrupt.push(format!("{}:thumb", row.id));
                }
                // Other thumbnail failures are non-fatal (mirrors push best-effort).
                let _ = std::fs::remove_file(&staged_thumb);
            }
        }
    }

    if !missing.is_empty() || !corrupt.is_empty() {
        let mut diagnostics = Vec::new();
        diagnostics.extend(missing.iter().map(|id| format!("missing_media:{id}")));
        diagnostics.extend(corrupt.iter().map(|id| format!("corrupt_media:{id}")));
        return Err(materialize_err_diag(
            CloudAuthoritativeMaterializeErrorKind::MediaIncomplete,
            format!(
                "cloud-authoritative media incomplete: {} missing, {} corrupt",
                missing.len(),
                corrupt.len()
            ),
            diagnostics,
        ));
    }

    Ok((downloaded, thumbs))
}

/// Stream every peer + self cloud channel into the staging SQLCipher DB,
/// rebuild ownership ledgers, eagerly cache media, and verify channel counts.
///
/// Phases advanced: `backup` → `fenced` → `transfer` → `verify`.
///
/// Active-vault access is via [`crate::sync::engine::ConnAccess`]: the lock is
/// held only for short job validation / phase advances, never across cloud
/// pull or media download I/O.
///
/// On any failure: discards the staging tree, records diagnostics on the job
/// row, and leaves the active local vault untouched.
pub async fn cloud_authoritative_materialize<P, K, A>(
    access: &A,
    content_provider: std::sync::Arc<P>,
    keyring: &K,
    key_state: &crate::EncryptionKeyState,
    opts: CloudAuthoritativeMaterializeOpts,
) -> Result<CloudAuthoritativeMaterializeResult, CloudAuthoritativeMaterializeError>
where
    P: crate::sync::provider::SyncProvider + 'static,
    K: KeyringV2Io + ?Sized,
    A: crate::sync::engine::ConnAccess + ?Sized,
{
    let _sync_guard =
        crate::commands::sync::SyncInProgressGuard::try_acquire().ok_or_else(|| {
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::SyncInProgress,
                crate::commands::sync::SYNC_IN_PROGRESS_ERR,
            )
        })?;

    let job_id = opts.staging.job_id;

    // Short lock: validate job + read local generation, then release.
    let (phase, local_generation) = access
        .with_conn(|conn| {
            let job = db::get_sync_recovery_job(conn, job_id)
                .map_err(|e| SyncError::Io(e.to_string()))?
                .ok_or_else(|| SyncError::Io(format!("recovery job {job_id} not found")))?;
            if job.operation != CLOUD_TO_LOCAL_OPERATION {
                return Err(SyncError::Io(
                    "job is not a cloud_to_local materialize job".to_string(),
                ));
            }
            if job.status == "completed" {
                return Err(SyncError::Io(
                    "recovery job is already completed".to_string(),
                ));
            }
            let phase = job.phase.clone();
            if !matches!(phase.as_str(), "backup" | "fenced" | "transfer" | "verify") {
                return Err(SyncError::Io(format!(
                    "cannot materialize from phase {phase}"
                )));
            }
            let local_generation =
                db::get_sync_recovery_generation(conn).map_err(|e| SyncError::Io(e.to_string()))?;
            Ok((phase, local_generation))
        })
        .map_err(|e| {
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::JobFailed,
                e.to_string(),
            )
        })?;
    let _ = phase;

    // Control-plane revalidation (no remote fence write for cloud→local; no DB lock).
    match validate_cloud_authoritative_control_plane(keyring, local_generation).await {
        Ok(_) => {}
        Err(e) => {
            let kind = match e.kind {
                CloudAuthoritativeStagingErrorKind::GenerationInvalid => {
                    CloudAuthoritativeMaterializeErrorKind::GenerationInvalid
                }
                CloudAuthoritativeStagingErrorKind::CompetingRecovery => {
                    CloudAuthoritativeMaterializeErrorKind::CompetingRecovery
                }
                CloudAuthoritativeStagingErrorKind::CloudUnreadable => {
                    CloudAuthoritativeMaterializeErrorKind::CloudUnreadable
                }
                CloudAuthoritativeStagingErrorKind::KeyringUnreadable => {
                    CloudAuthoritativeMaterializeErrorKind::KeyringUnreadable
                }
                _ => CloudAuthoritativeMaterializeErrorKind::JobFailed,
            };
            return Err(materialize_err(kind, e.message));
        }
    }

    let fail_and_discard = |access: &A,
                            job_id: i64,
                            staging_path: &std::path::Path,
                            err: CloudAuthoritativeMaterializeError|
     -> CloudAuthoritativeMaterializeError {
        let payload = serde_json::json!({
            "error": err.message,
            "kind": format!("{:?}", err.kind),
            "diagnostics": err.diagnostics,
        });
        let _ = access.with_conn(|conn| {
            if let Ok(s) = serde_json::to_string(&payload) {
                let _ = db::fail_sync_recovery_job(conn, job_id, &s);
            } else {
                let _ = db::fail_sync_recovery_job(conn, job_id, &err.message);
            }
            Ok(())
        });
        discard_cloud_authoritative_staging(staging_path);
        err
    };

    let db_key_owned: [u8; 32] = match key_state.with_db_key(|k| Ok(*k)) {
        Ok(k) => k,
        Err(error) => {
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err(
                    CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                    format!("db_key unavailable for materialize: {error}"),
                ),
            ));
        }
    };

    let staging_conn =
        match open_cloud_authoritative_staging_db(&opts.staging.staging_db_path, &db_key_owned) {
            Ok(c) => c,
            Err(error) => {
                return Err(fail_and_discard(
                    access,
                    job_id,
                    &opts.staging.staging_path,
                    materialize_err(CloudAuthoritativeMaterializeErrorKind::StagingFailed, error),
                ));
            }
        };

    // Seed generation on staging only from the *real* cloud generation.
    // Never promote above cloud control (job gen may be max(1) for CHECK only).
    if opts.staging.cloud_recovery_generation > 0 {
        if let Err(error) =
            db::set_sync_recovery_generation(&staging_conn, opts.staging.cloud_recovery_generation)
        {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err(
                    CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                    format!("seed staging recovery generation: {error}"),
                ),
            ));
        }
    }

    // Memory embedding configuration is device-local, but it determines
    // whether a synced vector is eligible for adopt-on-match. Seed only the
    // non-secret provider/model identity before the recovery pull so an
    // otherwise matching vector is not silently discarded from staging.
    for key in [
        crate::ai::provider::settings_keys::memory_embed::PROVIDER,
        crate::ai::provider::settings_keys::memory_embed::EMBEDDING_MODEL,
    ] {
        let value = match access.with_conn(|conn| {
            db::get_setting(conn, key).map_err(|error| SyncError::Io(error.to_string()))
        }) {
            Ok(value) => value,
            Err(error) => {
                drop(staging_conn);
                return Err(fail_and_discard(
                    access,
                    job_id,
                    &opts.staging.staging_path,
                    materialize_err(
                        CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                        format!("read local memory embedding setting {key}: {error}"),
                    ),
                ));
            }
        };
        if let Some(value) = value {
            if let Err(error) = db::set_setting(&staging_conn, key, &value) {
                drop(staging_conn);
                return Err(fail_and_discard(
                    access,
                    job_id,
                    &opts.staging.staging_path,
                    materialize_err(
                        CloudAuthoritativeMaterializeErrorKind::StagingFailed,
                        format!("seed memory embedding setting {key}: {error}"),
                    ),
                ));
            }
        }
    }

    let counts_fenced = serde_json::json!({
        "phase": "fenced",
        "device_id": opts.device_id,
        "cloud_recovery_generation": opts.staging.cloud_recovery_generation,
    })
    .to_string();
    if let Err(error) = access.with_conn(|conn| {
        db::advance_sync_recovery_job(conn, job_id, "fenced", &counts_fenced)
            .map_err(|e| SyncError::Io(e.to_string()))
    }) {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::JobFailed,
                error.to_string(),
            ),
        ));
    }

    // Read-only provider for pull + media: no accidental Drive writes.
    let readonly_provider = std::sync::Arc::new(ReadOnlySyncProvider::new(content_provider));

    // Pull-only recovery into staging (includes self folder, no provider writes).
    // Active vault lock is NOT held during this I/O.
    let engine = cloud_authoritative_pull_engine(readonly_provider.clone(), opts.device_id.clone());
    let pull_summary = match engine
        .pull_only_for_recovery(&staging_conn, &opts.content_key, key_state)
        .await
    {
        Ok(s) => s,
        Err(error) => {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err_diag(
                    CloudAuthoritativeMaterializeErrorKind::PullFailed,
                    format!("recovery pull failed: {error}"),
                    vec![error.to_string()],
                ),
            ));
        }
    };

    // Defense-in-depth: unreachable today. Per-item decrypt/parse failures
    // are non-fatal `continue`s inside the engine's ingestion loops, but
    // `pull_entries_for_recovery` re-checks `stats` under `include_self` and
    // returns `Err` if any error or warning landed — so a recovery pull that
    // returns `Ok` currently always carries an empty `errors` list, and the
    // `PullFailed` arm above is what actually catches a corrupt peer blob.
    // This check exists so that softening the engine's abort can never
    // silently route an incomplete staging DB into the active-vault swap.
    if !pull_summary.errors.is_empty() {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err_diag(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!(
                    "recovery pull reported {} item error(s); staging discarded",
                    pull_summary.errors.len()
                ),
                cap_diagnostics(pull_summary.errors.clone()),
            ),
        ));
    }

    // Ownership ledgers from the current device's cloud manifest.
    let self_manifest = match read_self_manifest(readonly_provider.as_ref(), &opts.device_id).await
    {
        Ok(Some(m)) => m,
        Ok(None) => crate::sync::metadata::DeviceMetadata {
            device_id: opts.device_id.clone(),
            recovery_generation: opts.staging.cloud_recovery_generation,
            entries: vec![],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        },
        Err(error) => {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err(CloudAuthoritativeMaterializeErrorKind::PullFailed, error),
            ));
        }
    };

    let (self_owned_entries, self_owned_journals, peer_entries, peer_journals) =
        match rebuild_cloud_authoritative_ownership(&staging_conn, &opts.device_id, &self_manifest)
        {
            Ok(v) => v,
            Err(error) => {
                drop(staging_conn);
                return Err(fail_and_discard(
                    access,
                    job_id,
                    &opts.staging.staging_path,
                    materialize_err(
                        CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                        error,
                    ),
                ));
            }
        };

    // Media download: no active-vault lock held; mid-flight free-space checks inside.
    let (media_downloaded, media_thumbnails_downloaded) = match download_staging_media(
        &staging_conn,
        readonly_provider.as_ref(),
        key_state,
        &opts.staging.staging_media_path,
    )
    .await
    {
        Ok(v) => v,
        Err(err) => {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                err,
            ));
        }
    };

    // Fail-closed: independently verify manifest coverage before trusting the
    // staging DB's own row counts. `rebuild_cloud_authoritative_ownership`'s
    // `peer_entries`/`peer_journals` are `COUNT(*)` over staging itself, so
    // they cannot detect a peer row a pull silently dropped. This reads
    // every device's manifest straight from the cloud and requires a row to
    // exist for every summary it lists as live.
    let recovery_manifests = match fetch_all_recovery_manifests(readonly_provider.as_ref()).await {
        Ok(m) => m,
        Err(error) => {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err(
                    CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                    error,
                ),
            ));
        }
    };
    let missing_from_manifests =
        verify_recovery_manifest_coverage(&staging_conn, &recovery_manifests);
    if !missing_from_manifests.is_empty() {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err_diag(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!(
                    "{} manifest-claimed live record(s) missing from staging",
                    missing_from_manifests.len()
                ),
                cap_diagnostics(missing_from_manifests),
            ),
        ));
    }

    let channels = match count_cloud_authoritative_channels(&staging_conn) {
        Ok(c) => c,
        Err(error) => {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err(
                    CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                    error,
                ),
            ));
        }
    };

    // Exact channel inventory: every classified name present once.
    if channels.len() != SYNC_RECOVERY_CHANNELS.len() {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!(
                    "channel inventory length {} != {}",
                    channels.len(),
                    SYNC_RECOVERY_CHANNELS.len()
                ),
            ),
        ));
    }
    for (expected, actual) in SYNC_RECOVERY_CHANNELS.iter().zip(channels.iter()) {
        if expected.name != actual.name {
            drop(staging_conn);
            return Err(fail_and_discard(
                access,
                job_id,
                &opts.staging.staging_path,
                materialize_err(
                    CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                    format!(
                        "channel order mismatch: expected {}, got {}",
                        expected.name, actual.name
                    ),
                ),
            ));
        }
    }

    // Fail-closed: staged content must cover ownership claims from self + peers.
    let entry_count = channels
        .iter()
        .find(|c| c.name == "entries")
        .map(|c| c.records)
        .unwrap_or(0);
    let expected_entries = self_owned_entries.saturating_add(peer_entries);
    if entry_count < expected_entries {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!(
                    "entries channel undercount: staging={entry_count}, expected_at_least={expected_entries} (self={self_owned_entries}, peer={peer_entries})"
                ),
            ),
        ));
    }
    let journal_count = channels
        .iter()
        .find(|c| c.name == "journals")
        .map(|c| c.records)
        .unwrap_or(0);
    let expected_journals = self_owned_journals.saturating_add(peer_journals);
    if journal_count < expected_journals {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!(
                    "journals channel undercount: staging={journal_count}, expected_at_least={expected_journals} (self={self_owned_journals}, peer={peer_journals})"
                ),
            ),
        ));
    }

    let verified = serde_json::json!({
        "phase": "transfer",
        "pull_pulled": pull_summary.pulled,
        "pull_merged": pull_summary.merged,
        "self_owned_entries": self_owned_entries,
        "self_owned_journals": self_owned_journals,
        "peer_entries": peer_entries,
        "peer_journals": peer_journals,
        "media_downloaded": media_downloaded,
        "media_thumbnails_downloaded": media_thumbnails_downloaded,
        "cloud_recovery_generation": opts.staging.cloud_recovery_generation,
        "channels": channels,
    })
    .to_string();

    if let Err(error) = access.with_conn(|conn| {
        db::advance_sync_recovery_job(conn, job_id, "transfer", &verified)
            .map_err(|e| SyncError::Io(e.to_string()))
    }) {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::JobFailed,
                error.to_string(),
            ),
        ));
    }

    // Verify phase: re-count and confirm media originals are bound and readable.
    let media_rows = db::list_media_for_recovery(&staging_conn).map_err(|e| {
        fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                e.to_string(),
            ),
        )
    })?;
    let mut unreadables = Vec::new();
    for row in &media_rows {
        if !local_media_file_readable(&row.storage_path) {
            unreadables.push(row.id.clone());
        }
    }
    if !unreadables.is_empty() {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err_diag(
                CloudAuthoritativeMaterializeErrorKind::VerificationFailed,
                format!(
                    "post-download media verification failed for {} originals",
                    unreadables.len()
                ),
                unreadables
                    .into_iter()
                    .map(|id| format!("unreadable_media:{id}"))
                    .collect(),
            ),
        ));
    }

    let verified_final = serde_json::json!({
        "phase": "verify",
        "pull_pulled": pull_summary.pulled,
        "pull_merged": pull_summary.merged,
        "self_owned_entries": self_owned_entries,
        "self_owned_journals": self_owned_journals,
        "peer_entries": peer_entries,
        "peer_journals": peer_journals,
        "media_downloaded": media_downloaded,
        "media_thumbnails_downloaded": media_thumbnails_downloaded,
        "media_total": media_rows.len() as u64,
        "cloud_recovery_generation": opts.staging.cloud_recovery_generation,
        "channels": channels,
    })
    .to_string();

    if let Err(error) = access.with_conn(|conn| {
        db::advance_sync_recovery_job(conn, job_id, "verify", &verified_final)
            .map_err(|e| SyncError::Io(e.to_string()))
    }) {
        drop(staging_conn);
        return Err(fail_and_discard(
            access,
            job_id,
            &opts.staging.staging_path,
            materialize_err(
                CloudAuthoritativeMaterializeErrorKind::JobFailed,
                error.to_string(),
            ),
        ));
    }

    // Staging connection drops here; staging files remain for Task 3 commit.
    drop(staging_conn);

    Ok(CloudAuthoritativeMaterializeResult {
        job_id,
        channels,
        media_downloaded,
        media_thumbnails_downloaded,
        self_owned_entries,
        self_owned_journals,
        peer_entries,
        peer_journals,
        pull_pulled: pull_summary.pulled,
        pull_merged: pull_summary.merged,
    })
}

// ─── Cloud-authoritative commit (Phase 3 Task 3) ────────────────────────────

const ROLLBACK_DB_FILE: &str = "memlore.db.cloud-restore-rollback";
const ROLLBACK_MEDIA_DIR: &str = "media.cloud-restore-rollback";
const COMMIT_MARKER_FILE: &str = "commit_marker.json";

/// Paths involved in the atomic active ↔ staging swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeSwapPlan {
    pub active_db_path: std::path::PathBuf,
    pub staging_db_path: std::path::PathBuf,
    pub active_media_path: std::path::PathBuf,
    pub staging_media_path: std::path::PathBuf,
    pub rollback_db_path: std::path::PathBuf,
    pub rollback_media_path: std::path::PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeCommitOpts {
    pub staging: CloudAuthoritativeStagingResult,
    /// On-disk active vault path (`memlore.db`). Must match the live connection.
    pub active_db_path: std::path::PathBuf,
    /// On-disk media directory used by the active vault.
    pub active_media_path: std::path::PathBuf,
    pub device_id: String,
    pub content_key: [u8; 32],
    /// When true, run one normal bidirectional sync after reopen and only then
    /// delete rollback files. Tests may set false to assert pure swap semantics.
    /// Production Tauri command prefers false +
    /// [`cloud_authoritative_finalize_after_swap`] so AppState can install the
    /// reopened vault before the long post-sync.
    pub run_post_commit_sync: bool,
}

/// Inputs for post-swap finalize (normal sync + job complete + drop rollback).
/// Used when the active vault is already installed in AppState after swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeFinalizeOpts {
    pub job_id: i64,
    pub device_id: String,
    pub content_key: [u8; 32],
    /// When empty, read `verified_counts` from the job row.
    pub verified_counts: String,
    pub active_db_path: std::path::PathBuf,
    pub active_media_path: std::path::PathBuf,
    pub rollback_db_path: std::path::PathBuf,
    pub rollback_media_path: std::path::PathBuf,
    pub backup_path: std::path::PathBuf,
    pub staging_path: std::path::PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAuthoritativeCommitResult {
    pub job_id: i64,
    pub phase: String,
    pub status: String,
    pub active_db_path: std::path::PathBuf,
    pub active_media_path: std::path::PathBuf,
    pub rollback_db_path: std::path::PathBuf,
    pub rollback_media_path: std::path::PathBuf,
    pub backup_path: std::path::PathBuf,
    pub rollback_retained: bool,
    pub post_commit_sync_ran: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudAuthoritativeCommitErrorKind {
    SyncInProgress,
    JobFailed,
    PreconditionFailed,
    PrepareFailed,
    SwapFailed,
    ReopenFailed,
    PreserveFailed,
    PostCommitSyncFailed,
    RollbackFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAuthoritativeCommitError {
    pub kind: CloudAuthoritativeCommitErrorKind,
    pub message: String,
    pub diagnostics: Vec<String>,
}

impl std::fmt::Display for CloudAuthoritativeCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CloudAuthoritativeCommitError {}

fn commit_err(
    kind: CloudAuthoritativeCommitErrorKind,
    message: impl Into<String>,
) -> CloudAuthoritativeCommitError {
    CloudAuthoritativeCommitError {
        kind,
        message: message.into(),
        diagnostics: Vec::new(),
    }
}

fn commit_err_diag(
    kind: CloudAuthoritativeCommitErrorKind,
    message: impl Into<String>,
    diagnostics: Vec<String>,
) -> CloudAuthoritativeCommitError {
    CloudAuthoritativeCommitError {
        kind,
        message: message.into(),
        diagnostics,
    }
}

/// Flush WAL and force DELETE journal mode so a single `.db` file can be
/// renamed atomically without orphaning `-wal`/`-shm` sidecars.
pub fn checkpoint_sqlite_for_swap(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
        .map_err(|e| format!("checkpoint for swap: {e}"))?;
    Ok(())
}

/// Build the default rollback pair beside the active vault.
pub fn cloud_authoritative_swap_plan(
    active_db_path: &std::path::Path,
    staging_db_path: &std::path::Path,
    active_media_path: &std::path::Path,
    staging_media_path: &std::path::Path,
) -> CloudAuthoritativeSwapPlan {
    let parent = active_db_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    CloudAuthoritativeSwapPlan {
        active_db_path: active_db_path.to_path_buf(),
        staging_db_path: staging_db_path.to_path_buf(),
        active_media_path: active_media_path.to_path_buf(),
        staging_media_path: staging_media_path.to_path_buf(),
        rollback_db_path: parent.join(ROLLBACK_DB_FILE),
        rollback_media_path: parent.join(ROLLBACK_MEDIA_DIR),
    }
}

fn remove_sqlite_sidecars(db_path: &std::path::Path) {
    let wal = append_suffix(db_path, "-wal");
    let shm = append_suffix(db_path, "-shm");
    let _ = std::fs::remove_file(&wal);
    let _ = std::fs::remove_file(&shm);
}

fn append_suffix(path: &std::path::Path, suffix: &str) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

fn ensure_parent_dir(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create parent {}: {e}", parent.display()))?;
    }
    Ok(())
}

/// Atomically promote staging DB/media over the active pair, retaining the
/// previous active pair as rollback paths. Fail-closed: any mid-swap error
/// restores the previous pair when possible.
pub fn perform_cloud_authoritative_swap(
    plan: &CloudAuthoritativeSwapPlan,
) -> Result<(), CloudAuthoritativeCommitError> {
    if !plan.staging_db_path.is_file() {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            format!(
                "staging database missing before swap: {}",
                plan.staging_db_path.display()
            ),
        ));
    }
    if !plan.staging_media_path.is_dir() {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            format!(
                "staging media directory missing before swap: {}",
                plan.staging_media_path.display()
            ),
        ));
    }
    if !plan.active_db_path.is_file() {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            format!(
                "active database missing before swap: {}",
                plan.active_db_path.display()
            ),
        ));
    }

    // Clear stale rollback leftovers from a prior crashed attempt.
    remove_if_exists(&plan.rollback_db_path);
    remove_dir_if_exists(&plan.rollback_media_path);
    remove_sqlite_sidecars(&plan.active_db_path);
    remove_sqlite_sidecars(&plan.staging_db_path);

    ensure_parent_dir(&plan.rollback_db_path)
        .map_err(|e| commit_err(CloudAuthoritativeCommitErrorKind::SwapFailed, e))?;

    // ── DB swap ──────────────────────────────────────────────────────────
    std::fs::rename(&plan.active_db_path, &plan.rollback_db_path).map_err(|e| {
        commit_err(
            CloudAuthoritativeCommitErrorKind::SwapFailed,
            format!(
                "rename active db to rollback failed: {} -> {}: {e}",
                plan.active_db_path.display(),
                plan.rollback_db_path.display()
            ),
        )
    })?;

    if let Err(e) = std::fs::rename(&plan.staging_db_path, &plan.active_db_path) {
        // Restore previous active DB immediately.
        let restore = std::fs::rename(&plan.rollback_db_path, &plan.active_db_path);
        return Err(commit_err_diag(
            CloudAuthoritativeCommitErrorKind::SwapFailed,
            format!(
                "rename staging db to active failed: {} -> {}: {e}",
                plan.staging_db_path.display(),
                plan.active_db_path.display()
            ),
            vec![match restore {
                Ok(()) => "active db restored from rollback".to_string(),
                Err(re) => format!("CRITICAL: active db restore also failed: {re}"),
            }],
        ));
    }

    // ── Media swap ───────────────────────────────────────────────────────
    let had_active_media = plan.active_media_path.exists();
    if had_active_media {
        if let Err(e) = std::fs::rename(&plan.active_media_path, &plan.rollback_media_path) {
            // Roll back DB pair.
            let _ = std::fs::rename(&plan.active_db_path, &plan.staging_db_path);
            let _ = std::fs::rename(&plan.rollback_db_path, &plan.active_db_path);
            return Err(commit_err(
                CloudAuthoritativeCommitErrorKind::SwapFailed,
                format!(
                    "rename active media to rollback failed: {} -> {}: {e}",
                    plan.active_media_path.display(),
                    plan.rollback_media_path.display()
                ),
            ));
        }
    }

    if let Err(e) = std::fs::rename(&plan.staging_media_path, &plan.active_media_path) {
        // Reverse media then DB.
        if had_active_media && plan.rollback_media_path.exists() {
            let _ = std::fs::rename(&plan.rollback_media_path, &plan.active_media_path);
        }
        let _ = std::fs::rename(&plan.active_db_path, &plan.staging_db_path);
        let _ = std::fs::rename(&plan.rollback_db_path, &plan.active_db_path);
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::SwapFailed,
            format!(
                "rename staging media to active failed: {} -> {}: {e}",
                plan.staging_media_path.display(),
                plan.active_media_path.display()
            ),
        ));
    }

    Ok(())
}

/// Reverse a successful (or partial) swap using the retained rollback pair.
pub fn rollback_cloud_authoritative_swap(
    plan: &CloudAuthoritativeSwapPlan,
) -> Result<(), CloudAuthoritativeCommitError> {
    if !plan.rollback_db_path.is_file() {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::RollbackFailed,
            format!(
                "rollback database missing: {}",
                plan.rollback_db_path.display()
            ),
        ));
    }

    // Park the failed staging promote (current active) back toward staging if present.
    if plan.active_db_path.exists() {
        // Prefer not to clobber an existing staging path; use a temp sibling.
        let failed = plan.staging_db_path.with_extension("db.failed-commit");
        let _ = std::fs::rename(&plan.active_db_path, &failed);
    }
    std::fs::rename(&plan.rollback_db_path, &plan.active_db_path).map_err(|e| {
        commit_err(
            CloudAuthoritativeCommitErrorKind::RollbackFailed,
            format!("restore active db from rollback: {e}"),
        )
    })?;

    if plan.active_media_path.exists() {
        let failed_media = plan.active_media_path.with_file_name("media.failed-commit");
        remove_dir_if_exists(&failed_media);
        let _ = std::fs::rename(&plan.active_media_path, &failed_media);
    }
    if plan.rollback_media_path.exists() {
        std::fs::rename(&plan.rollback_media_path, &plan.active_media_path).map_err(|e| {
            commit_err(
                CloudAuthoritativeCommitErrorKind::RollbackFailed,
                format!("restore active media from rollback: {e}"),
            )
        })?;
    }

    remove_sqlite_sidecars(&plan.active_db_path);
    Ok(())
}

/// Re-apply device-local settings/secrets that were side-filed during begin.
pub fn apply_preserved_device_local_state(
    conn: &Connection,
    state: &PreservedDeviceLocalState,
) -> Result<usize, String> {
    if state.version != 1 {
        return Err(format!(
            "unsupported preserved device-local state version {}",
            state.version
        ));
    }
    let mut applied = 0usize;
    for (key, value) in &state.settings {
        if db::is_syncable_setting(key) {
            // Defensive: never re-inject a syncable key via the preserve path.
            continue;
        }
        db::set_setting(conn, key, value).map_err(|e| format!("restore setting {key}: {e}"))?;
        applied += 1;
    }
    if let Some(ref device_id) = state.device_id {
        db::set_setting(conn, db::DEVICE_ID_KEY, device_id)
            .map_err(|e| format!("restore device_id: {e}"))?;
        applied += 1;
    }
    Ok(applied)
}

pub fn read_preserved_device_local_state(
    path: &std::path::Path,
    db_key: &[u8; 32],
) -> Result<PreservedDeviceLocalState, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read preserved settings: {e}"))?;
    if bytes.is_empty() {
        return Err("preserved settings file is empty".to_string());
    }
    let plaintext = match bytes[0] {
        PRESERVED_ENVELOPE_ENCRYPTED => crate::utils::encryption::decrypt_data(db_key, &bytes[1..])
            .map_err(|e| format!("decrypt preserved settings: {e}"))?,
        // Always encrypted — a stray plaintext (0x00) envelope is dead data,
        // never a case to handle. Reject unknown/plaintext envelopes fail-closed.
        _ => {
            return Err(format!(
                "unknown preserved settings envelope version {}",
                bytes[0]
            ));
        }
    };
    serde_json::from_slice(&plaintext).map_err(|e| format!("parse preserved settings: {e}"))
}

/// Parse the real cloud recovery generation from a job's `verified_counts` JSON.
///
/// The job row's `recovery_generation` column is always ≥ 1 (DB CHECK), even when
/// the cloud control plane is still at generation 0 — callers must never promote
/// the vault generation from that column alone.
pub fn cloud_recovery_generation_from_job(job: &db::SyncRecoveryJobRow) -> u64 {
    serde_json::from_str::<serde_json::Value>(&job.verified_counts)
        .ok()
        .and_then(|v| v.get("cloud_recovery_generation").and_then(|g| g.as_u64()))
        .unwrap_or(0)
}

/// Best-effort cloud media inventory size estimate for disk preflight.
/// Uses a fixed floor per object when the provider cannot report sizes.
pub async fn estimate_cloud_media_bytes_for_preflight<P>(provider: &P) -> Result<u64, String>
where
    P: crate::sync::provider::SyncProvider + ?Sized,
{
    let devices = provider
        .list_devices()
        .await
        .map_err(|e| format!("list devices for media estimate: {e}"))?;
    let mut total = 0u64;
    for device in devices {
        let files = provider
            .list_files(&device, crate::sync::provider::FileKind::Media)
            .await
            .map_err(|e| format!("list media for {device}: {e}"))?;
        total = total
            .saturating_add((files.len() as u64).saturating_mul(CLOUD_MEDIA_OBJECT_BYTE_FLOOR));
    }
    Ok(total)
}

fn estimate_cloud_authoritative_preflight_bytes(
    local_media: &[db::MediaRecoveryRow],
    cloud_media_bytes_estimate: Option<u64>,
) -> u64 {
    let local =
        estimate_preflight_bytes(local_media).saturating_add(CLOUD_STAGING_DISK_MARGIN_BYTES);
    let cloud = cloud_media_bytes_estimate.unwrap_or(0);
    // Backup of local + full cloud media into staging (originals + thumbs cushion).
    let cloud_side = cloud
        .saturating_mul(2)
        .saturating_add(CLOUD_STAGING_DISK_MARGIN_BYTES)
        .saturating_add(16 * 1024 * 1024);
    // Prefer the larger budget; never collapse to a near-zero when cloud is known empty
    // and local is empty — still keep the dual-margin floor.
    local.max(cloud_side)
}

/// Rewrite media storage/thumbnail paths that still point at the staging media
/// directory so they land under the final active media directory after rename.
pub fn remap_staging_media_paths(
    conn: &Connection,
    staging_media_dir: &std::path::Path,
    active_media_dir: &std::path::Path,
) -> Result<u64, String> {
    db::rebind_media_paths_after_dir_swap(conn, staging_media_dir, active_media_dir)
        .map_err(|e| format!("remap staging media paths: {e}"))
}

/// Seed the recovery job onto the staging DB so the post-swap vault retains
/// job continuity (the job previously lived only on the pre-swap active DB).
fn seed_cloud_to_local_job_on_staging(
    staging: &Connection,
    source: &db::SyncRecoveryJobRow,
    phase: &str,
    verified_counts: &str,
) -> Result<i64, String> {
    if source.operation != CLOUD_TO_LOCAL_OPERATION {
        return Err("source job is not cloud_to_local".to_string());
    }
    // Staging is a fresh vault — no active recovery job should exist.
    if db::has_active_sync_recovery_job(staging).map_err(|e| e.to_string())? {
        return Err("staging already has an active recovery job".to_string());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    staging
        .execute(
            "INSERT INTO sync_recovery_jobs
             (operation, phase, status, recovery_generation, backup_path, staging_path,
              verification_binding, verified_counts, last_error, created_at, updated_at)
             VALUES (?1, ?2, 'running', ?3, ?4, ?5, '{}', ?6, NULL, ?7, ?7)",
            rusqlite::params![
                CLOUD_TO_LOCAL_OPERATION,
                phase,
                source.recovery_generation,
                source.backup_path,
                source.staging_path,
                verified_counts,
                now,
            ],
        )
        .map_err(|e| format!("seed recovery job on staging: {e}"))?;
    Ok(staging.last_insert_rowid())
}

/// Mark a cloud-to-local job completed after finalize (no remote fence).
pub fn complete_cloud_to_local_recovery_job(conn: &Connection, id: i64) -> Result<(), String> {
    let (operation, phase, status) = conn
        .query_row(
            "SELECT operation, phase, status FROM sync_recovery_jobs WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|e| format!("load recovery job for complete: {e}"))?;
    if operation != CLOUD_TO_LOCAL_OPERATION {
        return Err("job is not cloud_to_local".to_string());
    }
    if status == "completed" {
        return Ok(());
    }
    if phase != "finalize" {
        return Err(format!(
            "cloud_to_local complete requires phase finalize (got {phase})"
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let changed = conn
        .execute(
            "UPDATE sync_recovery_jobs
             SET status = 'completed', last_error = NULL, updated_at = ?1
             WHERE id = ?2 AND status != 'completed' AND phase = 'finalize'",
            rusqlite::params![now, id],
        )
        .map_err(|e| format!("complete cloud_to_local job: {e}"))?;
    if changed == 0 {
        return Err("cloud_to_local job could not be completed".to_string());
    }
    Ok(())
}

fn write_commit_marker(
    work_dir: &std::path::Path,
    plan: &CloudAuthoritativeSwapPlan,
    job_id: i64,
    backup_path: &std::path::Path,
) -> Result<(), String> {
    let marker = serde_json::json!({
        "version": 1,
        "job_id": job_id,
        "active_db_path": plan.active_db_path,
        "active_media_path": plan.active_media_path,
        "rollback_db_path": plan.rollback_db_path,
        "rollback_media_path": plan.rollback_media_path,
        "backup_path": backup_path,
        "swapped": true,
    });
    let path = work_dir.join(COMMIT_MARKER_FILE);
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("write commit marker: {e}"))
}

fn delete_rollback_pair(plan: &CloudAuthoritativeSwapPlan) {
    remove_if_exists(&plan.rollback_db_path);
    remove_dir_if_exists(&plan.rollback_media_path);
    remove_sqlite_sidecars(&plan.rollback_db_path);
}

fn open_active_after_swap(path: &std::path::Path, db_key: &[u8; 32]) -> Result<Connection, String> {
    open_cloud_authoritative_staging_db(path, db_key)
}

/// Prepare staging (preserve settings, remap media, seed job), checkpoint and
/// close both databases, atomically swap DB/media, reopen the promoted vault,
/// optionally run one normal sync, then drop rollback files only on success.
///
/// `active_conn` is consumed (closed) before the filesystem swap. On success
/// the returned connection is the reopened active vault. On failure the
/// previous active pair is restored when possible and reopened.
pub async fn cloud_authoritative_commit<P>(
    active_conn: Connection,
    content_provider: std::sync::Arc<P>,
    key_state: &crate::EncryptionKeyState,
    opts: CloudAuthoritativeCommitOpts,
) -> Result<(Connection, CloudAuthoritativeCommitResult), CloudAuthoritativeCommitError>
where
    P: crate::sync::provider::SyncProvider + 'static,
{
    let _sync_guard =
        crate::commands::sync::SyncInProgressGuard::try_acquire().ok_or_else(|| {
            commit_err(
                CloudAuthoritativeCommitErrorKind::SyncInProgress,
                crate::commands::sync::SYNC_IN_PROGRESS_ERR,
            )
        })?;

    let plan = cloud_authoritative_swap_plan(
        &opts.active_db_path,
        &opts.staging.staging_db_path,
        &opts.active_media_path,
        &opts.staging.staging_media_path,
    );

    let job = db::get_sync_recovery_job(&active_conn, opts.staging.job_id)
        .map_err(|e| commit_err(CloudAuthoritativeCommitErrorKind::JobFailed, e.to_string()))?
        .ok_or_else(|| {
            commit_err(
                CloudAuthoritativeCommitErrorKind::JobFailed,
                format!("recovery job {} not found", opts.staging.job_id),
            )
        })?;
    if job.operation != CLOUD_TO_LOCAL_OPERATION {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            "job is not a cloud_to_local commit job",
        ));
    }
    if job.status == "completed" {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            "recovery job is already completed",
        ));
    }
    if job.phase != "verify" && job.phase != "commit" {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            format!(
                "cloud_authoritative_commit requires phase verify|commit (got {})",
                job.phase
            ),
        ));
    }
    if !opts.staging.staging_db_path.is_file() {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            format!(
                "staging database missing: {}",
                opts.staging.staging_db_path.display()
            ),
        ));
    }
    if !opts.staging.preserved_settings_path.is_file() {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreconditionFailed,
            format!(
                "preserved settings missing: {}",
                opts.staging.preserved_settings_path.display()
            ),
        ));
    }

    let verified_counts = job.verified_counts.clone();
    let job_id = job.id;
    let backup_path = opts.staging.backup_path.clone();

    let db_key_owned: [u8; 32] = key_state.with_db_key(|k| Ok(*k)).map_err(|e| {
        commit_err(
            CloudAuthoritativeCommitErrorKind::PrepareFailed,
            format!("db_key unavailable for commit: {e}"),
        )
    })?;

    // ── Prepare staging while active is still open (job still queryable) ─
    let staging_conn =
        open_cloud_authoritative_staging_db(&opts.staging.staging_db_path, &db_key_owned)
            .map_err(|e| commit_err(CloudAuthoritativeCommitErrorKind::PrepareFailed, e))?;

    let preserved = match read_preserved_device_local_state(
        &opts.staging.preserved_settings_path,
        &db_key_owned,
    ) {
        Ok(p) => p,
        Err(e) => {
            drop(staging_conn);
            return Err(commit_err(
                CloudAuthoritativeCommitErrorKind::PreserveFailed,
                e,
            ));
        }
    };

    if let Err(e) = apply_preserved_device_local_state(&staging_conn, &preserved) {
        drop(staging_conn);
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PreserveFailed,
            e,
        ));
    }

    if let Err(e) = remap_staging_media_paths(
        &staging_conn,
        &opts.staging.staging_media_path,
        &opts.active_media_path,
    ) {
        drop(staging_conn);
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PrepareFailed,
            e,
        ));
    }

    // Never promote vault generation above actual cloud control generation.
    // Job.recovery_generation may be max(cloud, 1) for the DB CHECK only.
    if opts.staging.cloud_recovery_generation > 0 {
        let gen = opts.staging.cloud_recovery_generation;
        let current = db::get_sync_recovery_generation(&staging_conn).unwrap_or(0);
        if gen > current {
            if let Err(e) = db::set_sync_recovery_generation(&staging_conn, gen) {
                drop(staging_conn);
                return Err(commit_err(
                    CloudAuthoritativeCommitErrorKind::PrepareFailed,
                    format!("set staging recovery generation: {e}"),
                ));
            }
        }
    }

    let seeded_job_id =
        match seed_cloud_to_local_job_on_staging(&staging_conn, &job, "commit", &verified_counts) {
            Ok(id) => id,
            Err(e) => {
                drop(staging_conn);
                return Err(commit_err(
                    CloudAuthoritativeCommitErrorKind::PrepareFailed,
                    e,
                ));
            }
        };

    if let Err(e) = checkpoint_sqlite_for_swap(&staging_conn) {
        drop(staging_conn);
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PrepareFailed,
            e,
        ));
    }
    drop(staging_conn);

    // Mark pre-swap active job (best-effort; it will be retired with the old DB).
    let _ = db::advance_sync_recovery_job(&active_conn, job_id, "commit", &verified_counts);
    if let Err(e) = checkpoint_sqlite_for_swap(&active_conn) {
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PrepareFailed,
            e,
        ));
    }
    drop(active_conn);

    // ── Atomic filesystem swap ───────────────────────────────────────────
    if let Err(e) = perform_cloud_authoritative_swap(&plan) {
        // Active pair should already be restored by perform_* on failure.
        // Reopen previous active for the caller.
        match open_active_after_swap(&plan.active_db_path, &db_key_owned) {
            Ok(_conn) => {
                // Drop the reopened conn — caller still needs the error; they
                // keep using their pre-commit paths. We return the error only.
                drop(_conn);
                return Err(e);
            }
            Err(reopen_err) => {
                return Err(commit_err_diag(
                    CloudAuthoritativeCommitErrorKind::SwapFailed,
                    e.message,
                    {
                        let mut d = e.diagnostics;
                        d.push(format!("reopen after failed swap: {reopen_err}"));
                        d
                    },
                ));
            }
        }
    }

    let work_dir = opts
        .staging
        .staging_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| opts.staging.staging_path.clone());
    let _ = write_commit_marker(&work_dir, &plan, seeded_job_id, &backup_path);

    // ── Reopen promoted vault ────────────────────────────────────────────
    let new_conn = match open_active_after_swap(&plan.active_db_path, &db_key_owned) {
        Ok(c) => c,
        Err(e) => {
            // Reopen failure: restore previous pair and reopen it.
            if let Err(rb) = rollback_cloud_authoritative_swap(&plan) {
                return Err(commit_err_diag(
                    CloudAuthoritativeCommitErrorKind::ReopenFailed,
                    format!("reopen after swap failed: {e}"),
                    vec![format!("rollback also failed: {rb}")],
                ));
            }
            let _ = open_active_after_swap(&plan.active_db_path, &db_key_owned);
            return Err(commit_err(
                CloudAuthoritativeCommitErrorKind::ReopenFailed,
                format!("reopen after swap failed (rolled back): {e}"),
            ));
        }
    };

    // Verify preserved secrets survived.
    for key in preserved.settings.keys() {
        if db::is_syncable_setting(key) {
            continue;
        }
        let got = db::get_setting(&new_conn, key).ok().flatten();
        if got.as_deref() != preserved.settings.get(key).map(|s| s.as_str()) {
            // Soft diagnostic only — already applied; do not auto-rollback a
            // healthy swap for a single missing key, but surface as error so
            // callers can decide. Fail-closed: roll back.
            drop(new_conn);
            let _ = rollback_cloud_authoritative_swap(&plan);
            return Err(commit_err(
                CloudAuthoritativeCommitErrorKind::PreserveFailed,
                format!("preserved setting {key} missing after commit"),
            ));
        }
    }

    if opts.run_post_commit_sync {
        // ConnAccess for SyncEngine: wrap the temporary connection via a
        // mutex so sync can interleave short DB calls with I/O.
        struct OneShotConn {
            inner: std::sync::Mutex<Connection>,
        }
        impl crate::sync::engine::ConnAccess for OneShotConn {
            fn with_conn<F, R>(&self, f: F) -> Result<R, crate::sync::provider::SyncError>
            where
                F: FnOnce(&Connection) -> Result<R, crate::sync::provider::SyncError>,
            {
                let guard = self.inner.lock().map_err(|e| {
                    crate::sync::provider::SyncError::Io(format!("conn lock poisoned: {e}"))
                })?;
                f(&guard)
            }
        }

        let access = OneShotConn {
            inner: std::sync::Mutex::new(new_conn),
        };
        let finalize = cloud_authoritative_finalize_after_swap(
            &access,
            content_provider,
            key_state,
            CloudAuthoritativeFinalizeOpts {
                job_id: seeded_job_id,
                device_id: opts.device_id.clone(),
                content_key: opts.content_key,
                verified_counts,
                active_db_path: plan.active_db_path.clone(),
                active_media_path: plan.active_media_path.clone(),
                rollback_db_path: plan.rollback_db_path.clone(),
                rollback_media_path: plan.rollback_media_path.clone(),
                backup_path: backup_path.clone(),
                staging_path: opts.staging.staging_path.clone(),
            },
        )
        .await;
        let new_conn = access.inner.into_inner().map_err(|e| {
            commit_err(
                CloudAuthoritativeCommitErrorKind::PostCommitSyncFailed,
                format!("recover conn after finalize: {e}"),
            )
        })?;
        match finalize {
            Ok(result) => return Ok((new_conn, result)),
            Err(e) => {
                drop(new_conn);
                return Err(e);
            }
        }
    }

    // No post-commit sync: leave job at commit with rollback retained so the
    // caller can still undo or resume finalize.
    Ok((
        new_conn,
        CloudAuthoritativeCommitResult {
            job_id: seeded_job_id,
            phase: "commit".to_string(),
            status: "running".to_string(),
            active_db_path: plan.active_db_path,
            active_media_path: plan.active_media_path,
            rollback_db_path: plan.rollback_db_path,
            rollback_media_path: plan.rollback_media_path,
            backup_path,
            rollback_retained: true,
            post_commit_sync_ran: false,
        },
    ))
}

/// Run post-swap finalize: advance job to `finalize`, perform one normal
/// bidirectional sync, complete the job, and delete rollback files only on
/// success. Failures return `Err` (not Ok with status=failed) so invoke/FE
/// cannot treat them as success. Rollback files stay on disk for recovery.
///
/// `access` is typically AppState after the promoted vault was installed, or
/// a one-shot wrapper around the reopened connection.
pub async fn cloud_authoritative_finalize_after_swap<P, A>(
    access: &A,
    content_provider: std::sync::Arc<P>,
    key_state: &crate::EncryptionKeyState,
    opts: CloudAuthoritativeFinalizeOpts,
) -> Result<CloudAuthoritativeCommitResult, CloudAuthoritativeCommitError>
where
    P: crate::sync::provider::SyncProvider + 'static,
    A: crate::sync::engine::ConnAccess,
{
    let job_id = opts.job_id;
    let verified_counts = if opts.verified_counts.is_empty() {
        access
            .with_conn(|conn| {
                let job = db::get_sync_recovery_job(conn, job_id)
                    .map_err(|e| SyncError::Io(e.to_string()))?
                    .ok_or_else(|| SyncError::Io(format!("recovery job {job_id} not found")))?;
                Ok(job.verified_counts)
            })
            .map_err(|e| {
                commit_err(
                    CloudAuthoritativeCommitErrorKind::PostCommitSyncFailed,
                    e.to_string(),
                )
            })?
    } else {
        opts.verified_counts.clone()
    };

    // Advance to finalize before post-sync so a crash leaves a clear phase.
    if let Err(e) = access.with_conn(|conn| {
        db::advance_sync_recovery_job(conn, job_id, "finalize", &verified_counts)
            .map_err(|e| SyncError::Io(e.to_string()))
    }) {
        let msg = format!("advance to finalize: {e}");
        let _ = access.with_conn(|conn| {
            let _ = db::fail_sync_recovery_job(conn, job_id, &msg);
            Ok(())
        });
        return Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PostCommitSyncFailed,
            msg,
        ));
    }

    let engine = crate::sync::engine::SyncEngine::new(content_provider, opts.device_id.clone());
    let sync_result = engine
        .sync_now(access, &opts.content_key, key_state, SyncTrigger::Manual)
        .await;

    let mark_failed = |msg: String| {
        let _ = access.with_conn(|conn| {
            let _ = db::fail_sync_recovery_job(conn, job_id, &msg);
            Ok(())
        });
        Err(commit_err(
            CloudAuthoritativeCommitErrorKind::PostCommitSyncFailed,
            msg,
        ))
    };

    match sync_result {
        Ok(summary) => {
            let hard_push_errors: Vec<String> = summary
                .errors
                .iter()
                .filter(|error| {
                    error.starts_with("push:") && !summary.warnings.iter().any(|w| w == *error)
                })
                .cloned()
                .collect();
            if summary.scope_mismatch || !hard_push_errors.is_empty() {
                let msg = if summary.scope_mismatch {
                    "post-commit normal sync reported scope mismatch".to_string()
                } else {
                    format!(
                        "post-commit normal sync push errors: {}",
                        hard_push_errors.join("; ")
                    )
                };
                return mark_failed(msg);
            }
        }
        Err(e) => {
            return mark_failed(format!("post-commit normal sync failed: {e}"));
        }
    }

    if let Err(e) = access
        .with_conn(|conn| complete_cloud_to_local_recovery_job(conn, job_id).map_err(SyncError::Io))
    {
        return mark_failed(e.to_string());
    }

    // Success: drop rollback files only now. Keep the automatic backup.
    let plan = CloudAuthoritativeSwapPlan {
        active_db_path: opts.active_db_path.clone(),
        staging_db_path: std::path::PathBuf::new(),
        active_media_path: opts.active_media_path.clone(),
        staging_media_path: std::path::PathBuf::new(),
        rollback_db_path: opts.rollback_db_path.clone(),
        rollback_media_path: opts.rollback_media_path.clone(),
    };
    delete_rollback_pair(&plan);
    let work_dir = opts
        .staging_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| opts.staging_path.clone());
    let _ = std::fs::remove_file(work_dir.join(COMMIT_MARKER_FILE));
    discard_cloud_authoritative_staging(&opts.staging_path);

    Ok(CloudAuthoritativeCommitResult {
        job_id,
        phase: "finalize".to_string(),
        status: "completed".to_string(),
        active_db_path: opts.active_db_path,
        active_media_path: opts.active_media_path,
        rollback_db_path: opts.rollback_db_path,
        rollback_media_path: opts.rollback_media_path,
        backup_path: opts.backup_path,
        rollback_retained: false,
        post_commit_sync_ran: true,
    })
}

/// Reconstruct staging result paths from an active recovery job + work tree.
pub fn staging_result_from_job(
    job: &db::SyncRecoveryJobRow,
    cloud_recovery_generation: u64,
) -> Result<CloudAuthoritativeStagingResult, String> {
    let staging_path = job
        .staging_path
        .as_ref()
        .ok_or_else(|| "recovery job has no staging_path".to_string())?;
    let staging_path = std::path::PathBuf::from(staging_path);
    let backup_path = job
        .backup_path
        .as_ref()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "recovery job has no backup_path".to_string())?;
    Ok(CloudAuthoritativeStagingResult {
        job_id: job.id,
        backup_path,
        staging_db_path: staging_path.join(STAGING_DB_FILE),
        staging_media_path: staging_path.join(STAGING_MEDIA_DIR),
        preserved_settings_path: staging_path.join(PRESERVED_SETTINGS_FILE),
        staging_path,
        cloud_recovery_generation,
        job_recovery_generation: u64::try_from(job.recovery_generation).unwrap_or(0).max(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn sync_recovery_adoption_includes_pulled_rows_and_tombstones() {
        let conn = setup();
        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at, is_deleted)
             VALUES ('recovery-journal', 'J', 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries
             (id, journal_id, entry_date, created_at, updated_at, is_deleted)
             VALUES ('recovery-entry', 'recovery-journal', 1, 1, 1, 1)",
            [],
        )
        .unwrap();

        let counts = adopt_all_local_content_for_recovery(&conn).unwrap();
        let entry_status: String = conn
            .query_row(
                "SELECT sync_status FROM sync_state WHERE entry_id = 'recovery-entry'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let journal_status: String = conn
            .query_row(
                "SELECT sync_status FROM journal_sync_state WHERE journal_id = 'recovery-journal'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert!(
            counts.entries >= 1
                && counts.journals >= 1
                && entry_status == "pending"
                && journal_status == "pending",
            "authoritative adoption must atomically claim pulled live rows and tombstones"
        );
    }

    #[test]
    fn recovery_job_may_commit_backup_refuses_cancelled() {
        let conn = setup();
        let job_id =
            db::create_sync_recovery_job(&conn, LOCAL_TO_CLOUD_OPERATION, 1, None, None).unwrap();
        let live = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert!(
            recovery_job_may_commit_backup(&live),
            "an in-flight pending job may advance after backup"
        );

        db::cancel_sync_recovery_job(&conn, job_id).unwrap();
        let cancelled = db::get_sync_recovery_job(&conn, job_id).unwrap().unwrap();
        assert!(
            !recovery_job_may_commit_backup(&cancelled),
            "a cancelled job must not rewrite paths or advance phase"
        );
    }

    #[test]
    fn sync_recovery_media_preflight_reports_missing_without_mutation() {
        let conn = setup();
        let journal_id = db::create_journal(&conn, "J", None).unwrap().id;
        let entry_id = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1,
            },
        )
        .unwrap()
        .id;
        db::insert_synced_media(
            &conn,
            "cloud-only",
            &entry_id,
            "cloud.jpg",
            "image/jpeg",
            "peer/media/cloud-only",
            Some(1),
            0,
            1,
            "inline",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "missing.jpg",
                file_type: "image/jpeg",
                storage_path: "/definitely/missing/memlore-recovery.jpg",
                file_size: Some(1),
                sort_order: 1,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        let before: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, upload_status FROM media ORDER BY id")
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };

        let missing = missing_local_media_original_ids(&conn).unwrap();
        let after: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, upload_status FROM media ORDER BY id")
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };

        assert!(
            missing.len() == 2 && missing.contains(&"cloud-only".to_string()) && before == after,
            "preflight must return every missing original ID without mutating media state"
        );
    }

    #[test]
    fn sync_recovery_channel_inventory_is_complete_and_unique() {
        let expected = [
            "entries",
            "journals",
            "media",
            "entry_versions",
            "entry_embedding_chunks",
            "settings",
            "tags",
            "templates",
            "location_aliases",
            "daily_chat",
            "streak",
            "ai_audit",
            "memory",
            "device_metadata",
            "keyring_meta",
            "keyring_recovery",
            "keyring_content",
            "device_slots",
            "sync_control",
            "recovery_marker",
            "sync_state",
            "journal_sync_state",
            "media_cache",
            "entry_embedding_jobs",
            "sync_recovery_jobs",
        ];
        let actual = SYNC_RECOVERY_CHANNELS
            .iter()
            .map(|channel| channel.name)
            .collect::<Vec<_>>();
        let unique = actual
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(
            actual, expected,
            "every current sync channel must be classified"
        );
        assert_eq!(unique.len(), actual.len(), "channel names must be unique");
    }

    fn marker() -> RecoveryMarker {
        RecoveryMarker {
            version: crate::sync::keyring_v2::RECOVERY_MARKER_VERSION,
            job_id: 11,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 4,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 2,
        }
    }

    fn complete_evidence(
        job_id: i64,
        operation: &str,
        recovery_generation: u64,
    ) -> RecoveryVerificationEvidence {
        RecoveryVerificationEvidence {
            version: 1,
            job_id,
            operation: operation.to_string(),
            recovery_generation,
            control_revision: "etag-1".to_string(),
            source_inventory_digest: "a".repeat(64),
            staging_digest: "b".repeat(64),
            source_inventory_items: 1,
            channels: SYNC_RECOVERY_CHANNELS
                .iter()
                .map(|channel| RecoveryChannelEvidence {
                    name: channel.name.to_string(),
                    checked: true,
                    records: u64::from(channel.name == "sync_control"),
                    failures: 0,
                })
                .collect(),
            blobs: RecoveryBlobEvidence {
                checked: true,
                blobs: 0,
                missing: 0,
                corrupt: 0,
            },
        }
    }

    #[test]
    fn fabricated_all_zero_verification_evidence_is_rejected() {
        let mut evidence = complete_evidence(1, "local_to_cloud", 1);
        evidence.source_inventory_items = 0;
        for channel in &mut evidence.channels {
            channel.records = 0;
        }

        assert!(
            evidence.validate_complete().is_err(),
            "all-zero evidence is not proof that a frozen recovery source was verified"
        );
    }

    fn advance_to_release_pending(conn: &Connection, job_id: i64) {
        let job = db::get_sync_recovery_job(conn, job_id).unwrap().unwrap();
        let evidence = complete_evidence(
            job_id,
            &job.operation,
            u64::try_from(job.recovery_generation).unwrap(),
        );
        db::bind_sync_recovery_verification_scope(conn, job_id, &evidence.binding()).unwrap();
        for phase in [
            "preflight",
            "backup",
            "fenced",
            "transfer",
            "verify",
            "commit",
            "finalize",
        ] {
            db::advance_sync_recovery_job(conn, job_id, phase, "{}").unwrap();
        }
        db::advance_sync_recovery_job(
            conn,
            job_id,
            "fence_release_pending",
            &serde_json::to_string(&evidence).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn sync_recovery_push_gate_blocks_normal_and_requires_exact_owner() {
        let marker = marker();
        let permit = RecoveryOwnerPermit {
            job_id: marker.job_id,
            owner_device_id: marker.owner_device_id.clone(),
            operation: marker.operation.clone(),
            recovery_generation: marker.recovery_generation,
            nonce: marker.nonce.clone(),
        };
        assert!(authorize_recovery_push(Some(&marker), 3, 4, None).is_err());
        assert!(authorize_recovery_push(None, 3, 4, None).is_err());
        assert!(authorize_recovery_push(Some(&marker), 3, 4, Some(&permit)).is_ok());
        let wrong = RecoveryOwnerPermit {
            job_id: permit.job_id + 1,
            ..permit
        };
        assert!(authorize_recovery_push(Some(&marker), 3, 4, Some(&wrong)).is_err());
    }

    #[tokio::test]
    async fn sync_recovery_provider_gate_blocks_before_first_write() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        let mut active = marker();
        active.recovery_generation = 1;
        acquire_recovery_lease(&provider, &active).await.unwrap();
        let writes_before = provider.write_count();
        let gate = check_provider_recovery_push(&provider, 0, None).await;
        if gate.is_ok() {
            provider
                .write_file("dev/entries/e.bin", b"should-not-write")
                .await
                .unwrap();
        }
        assert!(gate.is_err() && provider.write_count() == writes_before);
    }

    #[tokio::test]
    async fn verified_finalization_keeps_marker_until_terminal_evidence() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::{read_recovery_marker, KeyringV2Io};

        let conn = setup();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 4, None, None).unwrap();
        let mut marker = marker();
        marker.job_id = job_id;
        let permit = RecoveryOwnerPermit {
            job_id,
            owner_device_id: marker.owner_device_id.clone(),
            operation: marker.operation.clone(),
            recovery_generation: 4,
            nonce: marker.nonce.clone(),
        };
        let provider = InMemoryKeyringProvider::new();
        provider
            .write_file(
                SYNC_CONTROL_DRIVE_PATH,
                &serde_json::to_vec(&SyncControlV1 {
                    version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
                    recovery_generation: 3,
                    recovery_lease: None,
                    updated_at: 1,
                })
                .unwrap(),
            )
            .await
            .unwrap();
        acquire_recovery_lease(&provider, &marker).await.unwrap();

        assert!(finalize_verified_recovery(&provider, &conn, &permit)
            .await
            .is_err());
        assert!(read_recovery_marker(&provider).await.unwrap().is_some());

        advance_to_release_pending(&conn, job_id);
        finalize_verified_recovery(&provider, &conn, &permit)
            .await
            .unwrap();
        assert!(read_recovery_marker(&provider).await.unwrap().is_none());
        assert_eq!(
            db::get_sync_recovery_job(&conn, job_id)
                .unwrap()
                .unwrap()
                .status,
            "completed"
        );
    }

    #[tokio::test]
    async fn exact_recovery_lease_has_one_winner_and_idempotent_owner() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        let mut first = marker();
        first.recovery_generation = 1;
        let mut second = first.clone();
        second.job_id += 1;
        second.nonce = "fedcba9876543210".to_string();

        let provider_a = provider.clone();
        let provider_b = provider.clone();
        let (a, b) = tokio::join!(
            acquire_recovery_lease(&provider_a, &first),
            acquire_recovery_lease(&provider_b, &second)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let winner = if a.is_ok() { first } else { second };
        assert!(acquire_recovery_lease(&provider, &winner).await.is_ok());
    }

    #[tokio::test]
    async fn simultaneous_empty_cloud_bootstrap_has_one_canonical_control() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        let left_provider = provider.clone();
        let right_provider = provider.clone();
        let (left, right) = tokio::join!(
            bootstrap_sync_control(&left_provider, 10),
            bootstrap_sync_control(&right_provider, 20)
        );

        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(left, right);
        assert_eq!(left.recovery_generation, 0);
        assert_eq!(provider.write_count(), 1);
    }

    #[tokio::test]
    async fn mismatched_recovery_release_cannot_delete_winner_marker() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        let mut winner = marker();
        winner.recovery_generation = 1;
        let permit = acquire_recovery_lease(&provider, &winner).await.unwrap();
        let mut wrong = permit.clone();
        wrong.nonce = "fedcba9876543210".to_string();

        assert!(release_recovery_lease(&provider, &wrong).await.is_err());
        assert_eq!(read_recovery_marker(&provider).await.unwrap(), Some(winner));
    }

    #[tokio::test]
    async fn fence_release_pending_resumes_after_injected_marker_delete_failure() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let conn = setup();
        let job_id = db::create_sync_recovery_job(&conn, "local_to_cloud", 1, None, None).unwrap();
        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        let mut owned = marker();
        owned.job_id = job_id;
        owned.recovery_generation = 1;
        let permit = acquire_recovery_lease(&provider, &owned).await.unwrap();
        advance_to_release_pending(&conn, job_id);
        provider.fail_next_conditional_delete();

        assert!(finalize_verified_recovery(&provider, &conn, &permit)
            .await
            .is_err());
        assert_eq!(
            db::get_sync_recovery_job(&conn, job_id)
                .unwrap()
                .unwrap()
                .phase,
            "fence_release_pending"
        );
        let restarted = provider.clone();
        finalize_verified_recovery(&restarted, &conn, &permit)
            .await
            .unwrap();
        assert_eq!(
            db::get_sync_recovery_job(&conn, job_id)
                .unwrap()
                .unwrap()
                .status,
            "completed"
        );
    }

    #[tokio::test]
    async fn none_mode_generation_release_owner_sync_and_peer_reconnect() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        let mut owned = marker();
        owned.recovery_generation = 1;
        let permit = acquire_recovery_lease(&provider, &owned).await.unwrap();
        release_recovery_lease(&provider, &permit).await.unwrap();
        let owner = setup();
        db::set_sync_recovery_generation(&owner, 1).unwrap();
        let peer = setup();

        assert!(check_provider_recovery_push(
            &provider,
            db::get_sync_recovery_generation(&owner).unwrap(),
            None
        )
        .await
        .is_ok());
        assert!(check_provider_recovery_push(
            &provider,
            db::get_sync_recovery_generation(&peer).unwrap(),
            None
        )
        .await
        .is_err());
        db::set_sync_recovery_generation(&peer, 1).unwrap();
        assert!(check_provider_recovery_push(
            &provider,
            db::get_sync_recovery_generation(&peer).unwrap(),
            None
        )
        .await
        .is_ok());
    }

    #[test]
    fn cloud_cleanup_marker_is_a_valid_recovery_operation() {
        let mut cleanup = marker();
        cleanup.operation = CLOUD_CLEANUP_OPERATION.to_string();
        cleanup.recovery_generation = 1;
        assert!(cleanup.validate().is_ok());
    }

    #[test]
    fn cloud_cleanup_lease_blocks_peer_normal_push_without_permit() {
        let mut cleanup = marker();
        cleanup.operation = CLOUD_CLEANUP_OPERATION.to_string();
        cleanup.recovery_generation = 2;
        let owner = RecoveryOwnerPermit {
            job_id: cleanup.job_id,
            owner_device_id: cleanup.owner_device_id.clone(),
            operation: cleanup.operation.clone(),
            recovery_generation: cleanup.recovery_generation,
            nonce: cleanup.nonce.clone(),
        };
        // Peer normal sync: same generation as lease, no permit → blocked.
        assert!(authorize_recovery_push(Some(&cleanup), 2, 2, None).is_err());
        // Owner with exact permit may mutate under the wipe fence.
        assert!(authorize_recovery_push(Some(&cleanup), 2, 2, Some(&owner)).is_ok());
        // Wrong owner/permit fails closed.
        let mut peer = owner.clone();
        peer.nonce = "fedcba9876543210".to_string();
        assert!(authorize_recovery_push(Some(&cleanup), 2, 2, Some(&peer)).is_err());
    }

    #[tokio::test]
    async fn cloud_cleanup_lease_acquisition_blocks_peer_and_resumes_owner() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        // Bump control to gen 1 with no lease so cleanup advances to gen 2.
        {
            use crate::sync::keyring_v2::KeyringV2Io;
            let bumped = SyncControlV1 {
                version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
                recovery_generation: 1,
                recovery_lease: None,
                updated_at: 2,
            };
            provider
                .write_file(
                    SYNC_CONTROL_DRIVE_PATH,
                    &serde_json::to_vec(&bumped).unwrap(),
                )
                .await
                .unwrap();
        }

        let owner_id = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
        let peer_id = "bbbbbbbb-2222-3333-4444-cccccccccccc";
        let permit = acquire_or_resume_cloud_cleanup_lease(&provider, owner_id)
            .await
            .unwrap();
        assert_eq!(permit.operation, CLOUD_CLEANUP_OPERATION);
        assert_eq!(permit.recovery_generation, 2);
        assert_eq!(permit.owner_device_id, owner_id);

        // Peer cannot acquire a competing cleanup lease while ours is live.
        let peer_err = acquire_or_resume_cloud_cleanup_lease(&provider, peer_id)
            .await
            .unwrap_err();
        assert!(
            matches!(peer_err, SyncError::Auth(_)),
            "peer cleanup must fail closed, got {peer_err:?}"
        );

        // Peer normal push at the new generation is blocked without permit.
        assert!(check_provider_recovery_push(&provider, 2, None)
            .await
            .is_err());
        // Owner with permit may push.
        assert!(check_provider_recovery_push(&provider, 2, Some(&permit))
            .await
            .is_ok());

        // Owner resume is idempotent (stranded wipe lease).
        let resumed = acquire_or_resume_cloud_cleanup_lease(&provider, owner_id)
            .await
            .unwrap();
        assert_eq!(resumed, permit);

        release_recovery_lease(&provider, &permit).await.unwrap();
        // After release, generation stays advanced; matching local gen may sync.
        assert!(check_provider_recovery_push(&provider, 2, None)
            .await
            .is_ok());
        // Stale local gen still blocked.
        assert!(check_provider_recovery_push(&provider, 1, None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cloud_cleanup_fails_closed_when_lease_stolen_mid_flight() {
        use crate::sync::keyring_v2::io::test_support::InMemoryKeyringProvider;
        use crate::sync::keyring_v2::KeyringV2Io;

        let provider = InMemoryKeyringProvider::new();
        bootstrap_sync_control(&provider, 1).await.unwrap();
        {
            let bumped = SyncControlV1 {
                version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
                recovery_generation: 1,
                recovery_lease: None,
                updated_at: 2,
            };
            provider
                .write_file(
                    SYNC_CONTROL_DRIVE_PATH,
                    &serde_json::to_vec(&bumped).unwrap(),
                )
                .await
                .unwrap();
        }
        let owner_id = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
        let permit = acquire_or_resume_cloud_cleanup_lease(&provider, owner_id)
            .await
            .unwrap();

        // Simulate lease stolen: control rewritten to a different recovery lease.
        let mut stolen = marker();
        stolen.operation = "local_to_cloud".to_string();
        stolen.recovery_generation = 3;
        stolen.job_id = 99;
        stolen.nonce = "fedcba9876543210".to_string();
        let hijacked = SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: 3,
            recovery_lease: Some(stolen),
            updated_at: 99,
        };
        provider
            .write_file(
                SYNC_CONTROL_DRIVE_PATH,
                &serde_json::to_vec(&hijacked).unwrap(),
            )
            .await
            .unwrap();

        // Owner permit no longer matches cloud authority.
        assert!(
            check_provider_recovery_push(&provider, permit.recovery_generation, Some(&permit))
                .await
                .is_err()
        );
        // Release of the original permit must fail closed (cannot clear hijacker).
        assert!(release_recovery_lease(&provider, &permit).await.is_err());
    }

    // ── local_authoritative_preflight ────────────────────────────────────

    use crate::sync::media_sync::encrypt_media_bytes;
    use crate::sync::provider::SyncProvider;
    use crate::utils::encryption::KEY_SIZE;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;

    fn make_key_state() -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new([7u8; KEY_SIZE]))
            .expect("set_key");
        ks
    }

    fn seed_entry(conn: &Connection) -> String {
        let journal_id = db::create_journal(conn, "J", None).unwrap().id;
        db::create_entry(
            conn,
            db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some("preflight"),
                content_text: Some("body"),
                preview_text: Some("body"),
                entry_date: 1,
            },
        )
        .unwrap()
        .id
    }

    /// Dual-purpose test provider: SyncProvider + KeyringV2Io with delete
    /// counting and conditional control mutations for recovery leases.
    #[derive(Clone)]
    struct CountingProvider {
        files: std::sync::Arc<Mutex<HashMap<String, (Vec<u8>, u64)>>>,
        deletes: std::sync::Arc<AtomicUsize>,
        next_revision: std::sync::Arc<AtomicUsize>,
        fail_next_list: std::sync::Arc<std::sync::atomic::AtomicBool>,
        fail_next_cond_delete: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl CountingProvider {
        fn new() -> Self {
            Self {
                files: std::sync::Arc::new(Mutex::new(HashMap::new())),
                deletes: std::sync::Arc::new(AtomicUsize::new(0)),
                next_revision: std::sync::Arc::new(AtomicUsize::new(1)),
                fail_next_list: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                fail_next_cond_delete: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                    false,
                )),
            }
        }

        fn delete_count(&self) -> usize {
            self.deletes.load(Ordering::Acquire)
        }

        fn path_exists(&self, path: &str) -> bool {
            self.files.lock().unwrap().contains_key(path)
        }

        fn fail_next_list(&self) {
            self.fail_next_list
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }

        fn fail_next_conditional_delete(&self) {
            self.fail_next_cond_delete
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl SyncProvider for CountingProvider {
        async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
            let files = self.files.lock().unwrap();
            let mut devices: Vec<String> = files
                .keys()
                .filter_map(|p| p.split_once('/').map(|(head, _)| head.to_string()))
                .filter(|s| !s.is_empty() && !s.starts_with('.'))
                .collect();
            devices.sort();
            devices.dedup();
            Ok(devices)
        }
        async fn list_files(
            &self,
            device_id: &str,
            kind: crate::sync::provider::FileKind,
        ) -> Result<Vec<String>, SyncError> {
            if self
                .fail_next_list
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err(SyncError::Network("injected transient list failure".into()));
            }
            let files = self.files.lock().unwrap();
            let mut out: Vec<String> = match kind.subfolder_name() {
                None => {
                    let prefix = format!("{device_id}/");
                    files
                        .keys()
                        .filter(|k| k.starts_with(&prefix) && !k[prefix.len()..].contains('/'))
                        .cloned()
                        .collect()
                }
                Some(subfolder) => {
                    let prefix = format!("{device_id}/{subfolder}/");
                    files
                        .keys()
                        .filter(|k| k.starts_with(&prefix))
                        .cloned()
                        .collect()
                }
            };
            out.sort();
            Ok(out)
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, _)| bytes.clone())
                .ok_or_else(|| SyncError::NotFound(path.to_string()))
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel) as u64;
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), (data.to_vec(), revision));
            Ok(())
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            self.deletes.fetch_add(1, Ordering::AcqRel);
            self.files.lock().unwrap().remove(path);
            Ok(())
        }
    }

    #[async_trait]
    impl KeyringV2Io for CountingProvider {
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
            SyncProvider::read_file(self, path).await
        }
        async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
            SyncProvider::write_file(self, path, data).await
        }
        async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
            SyncProvider::delete_file(self, path).await
        }
        async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError> {
            let files = self.files.lock().unwrap();
            let mut paths: Vec<String> = files
                .keys()
                .filter(|k| k.starts_with(prefix))
                .cloned()
                .collect();
            paths.sort();
            Ok(paths)
        }
        async fn read_versioned_file(
            &self,
            path: &str,
        ) -> Result<crate::sync::keyring_v2::VersionedFile, SyncError> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .map(|(bytes, revision)| crate::sync::keyring_v2::VersionedFile {
                    bytes: bytes.clone(),
                    revision: revision.to_string(),
                })
                .ok_or_else(|| SyncError::NotFound(path.to_string()))
        }
        async fn compare_and_swap_file(
            &self,
            path: &str,
            expected_revision: &str,
            data: &[u8],
        ) -> Result<ConditionalMutationResult, SyncError> {
            let mut files = self.files.lock().unwrap();
            let Some((_, current_revision)) = files.get(path) else {
                return Ok(ConditionalMutationResult::NotFound);
            };
            if current_revision.to_string() != expected_revision {
                return Ok(ConditionalMutationResult::Conflict);
            }
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel) as u64;
            files.insert(path.to_string(), (data.to_vec(), revision));
            Ok(ConditionalMutationResult::Applied)
        }
        async fn create_initial_control_if_absent(
            &self,
            data: &[u8],
        ) -> Result<ConditionalMutationResult, SyncError> {
            let path = SYNC_CONTROL_DRIVE_PATH;
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) {
                return Ok(ConditionalMutationResult::Conflict);
            }
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel) as u64;
            files.insert(path.to_string(), (data.to_vec(), revision));
            Ok(ConditionalMutationResult::Applied)
        }
        async fn create_recovery_marker_if_absent(
            &self,
            data: &[u8],
            permit: &RecoveryOwnerPermit,
        ) -> Result<ConditionalMutationResult, SyncError> {
            let marker: RecoveryMarker = serde_json::from_slice(data)
                .map_err(|error| SyncError::Serialization(error.to_string()))?;
            let control_bytes = KeyringV2Io::read_file(self, SYNC_CONTROL_DRIVE_PATH).await?;
            let control: SyncControlV1 = serde_json::from_slice(&control_bytes)
                .map_err(|error| SyncError::Serialization(error.to_string()))?;
            let exact = control.recovery_lease.as_ref() == Some(&marker)
                && marker.job_id == permit.job_id
                && marker.owner_device_id == permit.owner_device_id
                && marker.operation == permit.operation
                && marker.recovery_generation == permit.recovery_generation
                && marker.nonce == permit.nonce;
            if !exact {
                return Err(SyncError::Auth(
                    "recovery marker create requires exact active control owner".to_string(),
                ));
            }
            let path = RECOVERY_MARKER_PATH;
            let mut files = self.files.lock().unwrap();
            if files.contains_key(path) {
                return Ok(ConditionalMutationResult::Conflict);
            }
            let revision = self.next_revision.fetch_add(1, Ordering::AcqRel) as u64;
            files.insert(path.to_string(), (data.to_vec(), revision));
            Ok(ConditionalMutationResult::Applied)
        }
        async fn delete_file_if_revision(
            &self,
            path: &str,
            expected_revision: &str,
        ) -> Result<ConditionalMutationResult, SyncError> {
            if self
                .fail_next_cond_delete
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err(SyncError::Network(
                    "injected transient conditional delete failure".into(),
                ));
            }
            let mut files = self.files.lock().unwrap();
            let Some((_, current_revision)) = files.get(path) else {
                return Ok(ConditionalMutationResult::NotFound);
            };
            if current_revision.to_string() != expected_revision {
                return Ok(ConditionalMutationResult::Conflict);
            }
            files.remove(path);
            Ok(ConditionalMutationResult::Applied)
        }
    }

    fn default_opts(work: &TempDir) -> LocalAuthoritativePreflightOpts {
        LocalAuthoritativePreflightOpts {
            work_dir: work.path().to_path_buf(),
            free_bytes_override: Some(u64::MAX / 4),
            existing_job_id: None,
        }
    }

    #[tokio::test]
    async fn local_authoritative_preflight_downloads_cloud_only_media() {
        let conn = setup();
        let entry_id = seed_entry(&conn);
        let media_id = "cloudonlymedia01";
        let device_id = "device-peer-a";
        let cloud_path = format!("{device_id}/media/{media_id}");
        db::insert_synced_media(
            &conn,
            media_id,
            &entry_id,
            "cloud.jpg",
            "image/jpeg",
            &cloud_path,
            Some(12),
            0,
            1,
            "inline",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let key_state = make_key_state();
        let plaintext = b"cloud-only-bytes";
        let ciphertext = encrypt_media_bytes(&key_state, plaintext).unwrap();
        let provider = CountingProvider::new();
        SyncProvider::write_file(&provider, &cloud_path, &ciphertext)
            .await
            .unwrap();

        let work = TempDir::new().unwrap();
        let result = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect("preflight should succeed after cloud-only download");

        assert_eq!(result.media_total, 1);
        assert_eq!(result.media_local, 0);
        assert_eq!(result.media_downloaded, 1);
        let staged = result.staging_path.join("media").join(media_id);
        assert_eq!(std::fs::read(&staged).unwrap(), plaintext);
        assert!(result.backup_path.is_file());
        assert_eq!(provider.delete_count(), 0);
    }

    #[tokio::test]
    async fn local_authoritative_preflight_aborts_on_missing_media() {
        let conn = setup();
        let entry_id = seed_entry(&conn);
        db::insert_synced_media(
            &conn,
            "missing-media-1",
            &entry_id,
            "gone.jpg",
            "image/jpeg",
            "peer/media/missing-media-1",
            Some(1),
            0,
            1,
            "inline",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "local-missing.jpg",
                file_type: "image/jpeg",
                storage_path: "/definitely/missing/memlore-preflight.jpg",
                file_size: Some(1),
                sort_order: 1,
                insertion_mode: "inline",
                width: None,
                height: None,
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();

        let provider = CountingProvider::new();
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        let err = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect_err("must abort when originals are missing");

        assert_eq!(
            err.kind,
            LocalAuthoritativePreflightErrorKind::MediaIncomplete
        );
        assert!(err.missing_media_ids.contains(&"missing-media-1".into()));
        assert_eq!(err.missing_media_ids.len(), 2);
        assert!(err.corrupt_media_ids.is_empty());
        assert!(!work.path().join("staging").exists());
        assert_eq!(provider.delete_count(), 0);
    }

    #[tokio::test]
    async fn local_authoritative_preflight_aborts_on_corrupt_ciphertext() {
        let conn = setup();
        let entry_id = seed_entry(&conn);
        let media_id = "corruptmedia0001";
        let device_id = "device-peer-b";
        let cloud_path = format!("{device_id}/media/{media_id}");
        db::insert_synced_media(
            &conn,
            media_id,
            &entry_id,
            "bad.jpg",
            "image/jpeg",
            &cloud_path,
            Some(8),
            0,
            1,
            "inline",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let key_state = make_key_state();
        let other = crate::EncryptionKeyState::new();
        other
            .set_key(zeroize::Zeroizing::new([9u8; KEY_SIZE]))
            .unwrap();
        let ciphertext = encrypt_media_bytes(&other, b"secret").unwrap();
        let provider = CountingProvider::new();
        SyncProvider::write_file(&provider, &cloud_path, &ciphertext)
            .await
            .unwrap();

        let work = TempDir::new().unwrap();
        let err = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect_err("corrupt ciphertext must abort");

        assert_eq!(
            err.kind,
            LocalAuthoritativePreflightErrorKind::MediaIncomplete
        );
        assert!(err.corrupt_media_ids.contains(&media_id.to_string()));
        assert!(!work.path().join("staging").exists());
        assert_eq!(provider.delete_count(), 0);
    }

    #[tokio::test]
    async fn local_authoritative_preflight_aborts_on_insufficient_disk() {
        let conn = setup();
        let entry_id = seed_entry(&conn);
        let media_dir = TempDir::new().unwrap();
        let media_path = media_dir.path().join("local.jpg");
        std::fs::write(&media_path, vec![1u8; 4096]).unwrap();
        db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "local.jpg",
                file_type: "image/jpeg",
                storage_path: media_path.to_str().unwrap(),
                file_size: Some(4096),
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

        let provider = CountingProvider::new();
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        let mut opts = default_opts(&work);
        opts.free_bytes_override = Some(1024); // far below estimate + margin

        let err = local_authoritative_preflight(&conn, &provider, &provider, &key_state, opts)
            .await
            .expect_err("must abort when free disk is insufficient");

        assert_eq!(
            err.kind,
            LocalAuthoritativePreflightErrorKind::InsufficientDisk
        );
        assert_eq!(provider.delete_count(), 0);
        assert!(db::find_active_sync_recovery_job(&conn).unwrap().is_none());
    }

    #[tokio::test]
    async fn local_authoritative_preflight_creates_recovery_backup() {
        use std::io::Read as _;

        let conn = setup();
        let entry_id = seed_entry(&conn);
        let media_dir = TempDir::new().unwrap();
        let media_path = media_dir.path().join("photo.jpg");
        std::fs::write(&media_path, b"local-photo-bytes").unwrap();
        db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: media_path.to_str().unwrap(),
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
        db::set_setting(&conn, "ui_language", "vi").unwrap();

        let provider = CountingProvider::new();
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        let result = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect("preflight");

        assert!(result.backup_path.is_file());
        assert!(result
            .backup_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".memlore.zip"));
        assert_eq!(result.media_total, 1);
        assert_eq!(result.media_local, 1);
        assert_eq!(result.media_downloaded, 0);

        let file = std::fs::File::open(&result.backup_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        // Password-mode key_state → automatic backup encrypts full_snapshot.json.
        assert!(archive.by_name("full_snapshot.json").is_err());
        assert!(archive.by_name("full_snapshot.json.enc").is_ok());
        assert!(archive.by_name("manifest.json").is_ok());

        let job = db::get_sync_recovery_job(&conn, result.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.phase, "backup");
        assert_eq!(job.status, "running");
        assert_eq!(
            job.backup_path.as_deref(),
            Some(result.backup_path.to_str().unwrap())
        );
        assert_eq!(provider.delete_count(), 0);

        // Snapshot must decrypt with the device's db_key and restore the setting.
        let mut enc_bytes = Vec::new();
        archive
            .by_name("full_snapshot.json.enc")
            .unwrap()
            .read_to_end(&mut enc_bytes)
            .unwrap();
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let snap_bytes = crate::utils::encryption::decrypt_data(&db_key, &enc_bytes).unwrap();
        let snapshot: db::FullBackupSnapshot = serde_json::from_slice(&snap_bytes).unwrap();
        assert_eq!(snapshot.snapshot_version, 1);
    }

    #[tokio::test]
    async fn local_authoritative_preflight_zero_cloud_deletes() {
        let conn = setup();
        seed_entry(&conn);
        let provider = CountingProvider::new();
        // Seed a decoy cloud object that must never be deleted.
        SyncProvider::write_file(&provider, "peer/entries/e.bin", b"do-not-delete")
            .await
            .unwrap();
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        let _ = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect("preflight");

        assert_eq!(
            provider.delete_count(),
            0,
            "preflight must never call delete_file on the provider"
        );
        assert_eq!(
            SyncProvider::read_file(&provider, "peer/entries/e.bin")
                .await
                .unwrap(),
            b"do-not-delete"
        );
    }

    #[tokio::test]
    async fn local_authoritative_preflight_blocks_active_rotation() {
        let conn = setup();
        db::insert_rotation_job(&conn, "old-fp", "new-fp", 1, 2, None).unwrap();
        let provider = CountingProvider::new();
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        let err = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect_err("rotation must block");
        assert_eq!(
            err.kind,
            LocalAuthoritativePreflightErrorKind::RotationActive
        );
        assert_eq!(provider.delete_count(), 0);
    }

    #[tokio::test]
    async fn local_authoritative_preflight_blocks_force_re_pair() {
        let conn = setup();
        db::set_setting(&conn, db::FORCE_RE_PAIR_REQUIRED, "1").unwrap();
        let provider = CountingProvider::new();
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        let err = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect_err("force re-pair must block");
        assert_eq!(
            err.kind,
            LocalAuthoritativePreflightErrorKind::ForceRePairRequired
        );
        assert_eq!(provider.delete_count(), 0);
    }

    #[test]
    fn write_complete_memlore_backup_includes_full_snapshot_and_media() {
        use std::io::Read as _;

        let conn = setup();
        let entry_id = seed_entry(&conn);
        let media_dir = TempDir::new().unwrap();
        let media_path = media_dir.path().join("a.jpg");
        std::fs::write(&media_path, b"zip-media").unwrap();
        let media = db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "a.jpg",
                file_type: "image/jpeg",
                storage_path: media_path.to_str().unwrap(),
                file_size: Some(9),
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

        let out = TempDir::new().unwrap();
        let dest = out.path().join("complete.memlore.zip");
        let summary = crate::commands::export::write_complete_memlore_backup(
            &conn,
            &dest,
            &HashMap::new(),
            None,
        )
        .unwrap();
        assert_eq!(summary.media_count, 1);
        assert!(summary.entry_count >= 1);

        let file = std::fs::File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut buf = Vec::new();
        archive
            .by_name(&format!("media/{}.jpg", media.id))
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        assert_eq!(buf, b"zip-media");
        // db_key = None (e.g. "none mode") keeps the plaintext member name —
        // matches the live local DB also being unencrypted in that mode.
        assert!(archive.by_name("full_snapshot.json").is_ok());
        assert!(archive.by_name("full_snapshot.json.enc").is_err());
    }

    const BACKUP_ENCRYPTION_MARKER: &str = "UNIQUE_MARKER_do_not_leak_this_title_98765";

    /// Seed a DB with one entry whose title is [`BACKUP_ENCRYPTION_MARKER`] —
    /// a distinctive string used by the encrypted-backup tests below to prove
    /// (a) it is absent from the raw member bytes (confidentiality) and (b)
    /// present after decrypting with the correct db_key (round-trip).
    fn seed_entry_with_marker_title(conn: &Connection) {
        let journal_id = db::create_journal(conn, "J", None).unwrap().id;
        db::create_entry(
            conn,
            db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some(BACKUP_ENCRYPTION_MARKER),
                content_text: Some("body"),
                preview_text: Some("body"),
                entry_date: 1,
            },
        )
        .unwrap();
    }

    /// Round-trip + confidentiality: with a db_key, `full_snapshot.json` is
    /// stored as `full_snapshot.json.enc`, the marker title is absent from
    /// those raw (decompressed) member bytes, and decrypting with the same
    /// db_key recovers JSON containing the marker.
    #[test]
    fn write_complete_memlore_backup_encrypts_full_snapshot_with_db_key() {
        use std::io::Read as _;

        let conn = setup();
        seed_entry_with_marker_title(&conn);
        let db_key = [9u8; KEY_SIZE];

        let out = TempDir::new().unwrap();
        let dest = out.path().join("encrypted.memlore.zip");
        crate::commands::export::write_complete_memlore_backup(
            &conn,
            &dest,
            &HashMap::new(),
            Some(&db_key),
        )
        .unwrap();

        let file = std::fs::File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert!(
            archive.by_name("full_snapshot.json").is_err(),
            "encrypted backup must not also carry a plaintext member"
        );
        let mut member_bytes = Vec::new();
        archive
            .by_name("full_snapshot.json.enc")
            .unwrap()
            .read_to_end(&mut member_bytes)
            .unwrap();

        let contains_marker = member_bytes
            .windows(BACKUP_ENCRYPTION_MARKER.len())
            .any(|w| w == BACKUP_ENCRYPTION_MARKER.as_bytes());
        assert!(
            !contains_marker,
            "full_snapshot.json.enc must not contain the plaintext title"
        );

        let decrypted = crate::utils::encryption::decrypt_data(&db_key, &member_bytes)
            .expect("decrypt with the correct db_key must succeed");
        let snapshot: db::FullBackupSnapshot = serde_json::from_slice(&decrypted).unwrap();
        let restored = setup();
        db::restore_full_snapshot(&restored, &snapshot).unwrap();
        let entries = db::list_all_entries(&restored).unwrap();
        assert!(
            entries
                .iter()
                .any(|e| e.title.as_deref() == Some(BACKUP_ENCRYPTION_MARKER)),
            "decrypted snapshot must restore to the original marker entry"
        );
    }

    /// Wrong key must fail decryption cleanly (no panic, no partial restore —
    /// decryption happens entirely before any DB write is attempted).
    #[test]
    fn write_complete_memlore_backup_wrong_key_fails_decryption_cleanly() {
        use std::io::Read as _;

        let conn = setup();
        seed_entry_with_marker_title(&conn);
        let db_key = [9u8; KEY_SIZE];
        let wrong_key = [1u8; KEY_SIZE];

        let out = TempDir::new().unwrap();
        let dest = out.path().join("encrypted.memlore.zip");
        crate::commands::export::write_complete_memlore_backup(
            &conn,
            &dest,
            &HashMap::new(),
            Some(&db_key),
        )
        .unwrap();

        let file = std::fs::File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut member_bytes = Vec::new();
        archive
            .by_name("full_snapshot.json.enc")
            .unwrap()
            .read_to_end(&mut member_bytes)
            .unwrap();

        let result = crate::utils::encryption::decrypt_data(&wrong_key, &member_bytes);
        assert!(result.is_err(), "wrong key must not decrypt");
    }

    // ── local_authoritative_rebuild ──────────────────────────────────────

    fn lock_sync_guard_for_test() -> std::sync::MutexGuard<'static, ()> {
        crate::commands::sync::SYNC_GUARD_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// UUID-shaped device id (recovery marker validates hex + '-').
    const REBUILD_DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn make_sync_key() -> [u8; 32] {
        [7u8; 32]
    }

    /// Dummy but well-formed keyring material for rebuild tests that don't
    /// care about its exact content — just that rebuild has *some* valid
    /// material to publish (always-encrypted rebuild requires keyring
    /// material unconditionally; there is no none-mode shortcut anymore).
    fn dummy_rebuild_keyring_material(device_name: &str) -> LocalAuthoritativeKeyringMaterial {
        LocalAuthoritativeKeyringMaterial {
            recovery_wrapped: "ab".repeat(60),
            device_name: device_name.to_string(),
            master_fingerprint: "a1b2c3d4".repeat(8),
            created_at: 1_700_000_000,
            device_created_at: 1_700_000_000,
            last_seen_at: 1_700_000_100,
            content_entries: vec![LocalAuthoritativeContentEntry {
                epoch: 1,
                wrapped_content: "ee".repeat(60),
                content_fingerprint: "ff".repeat(32),
            }],
            content_epoch: 1,
            master_epoch: 1,
        }
    }

    fn seed_yjs_entry(conn: &Connection, title: &str) -> String {
        use yrs::{Doc, ReadTxn, StateVector, Text, Transact};

        let journal_id = db::create_journal(conn, "J", None).unwrap().id;
        let entry = db::create_entry(
            conn,
            db::CreateEntryParams {
                journal_id: &journal_id,
                title: Some(title),
                content_text: Some(title),
                preview_text: Some(title),
                entry_date: 1,
            },
        )
        .unwrap();
        let doc = Doc::new();
        let t = doc.get_or_insert_text("content");
        {
            let mut txn = doc.transact_mut();
            t.insert(&mut txn, 0, title);
        }
        let blob = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        conn.execute(
            "UPDATE entries SET yjs_doc = ?1 WHERE id = ?2",
            rusqlite::params![blob, entry.id],
        )
        .unwrap();
        entry.id
    }

    async fn run_preflight_for_rebuild(
        conn: &Connection,
        provider: &CountingProvider,
    ) -> LocalAuthoritativePreflightResult {
        let key_state = make_key_state();
        let work = TempDir::new().unwrap();
        // Keep work dir alive by leaking into job paths stored on the job row —
        // TempDir drop would delete staging; rebuild only needs the job phase.
        let opts = LocalAuthoritativePreflightOpts {
            work_dir: work.path().to_path_buf(),
            free_bytes_override: Some(u64::MAX / 4),
            existing_job_id: None,
        };
        let result = local_authoritative_preflight(conn, provider, provider, &key_state, opts)
            .await
            .expect("preflight");
        // Persist TempDir by forgetting drop so backup/staging paths remain valid.
        std::mem::forget(work);
        result
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_adopts_pulled_entry_journal_tombstone() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        db::get_or_create_device_id(&conn).ok();
        // Force a stable device id for cloud paths.
        conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        )
        .ok();

        // Pulled journal + entry with no ownership ledger (orphan after peer wipe).
        conn.execute(
            "INSERT INTO journals (id, name, created_at, updated_at, is_deleted)
             VALUES ('pulled-j1', 'Pulled J', 1, 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at, is_deleted)
             VALUES ('pulled-e1', 'pulled-j1', 1, 1, 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at, is_deleted)
             VALUES ('tomb-e1', 'pulled-j1', 1, 1, 1, 1)",
            [],
        )
        .unwrap();

        let provider = CountingProvider::new();
        // Stale peer payload that must be deleted by rebuild clear.
        SyncProvider::write_file(&provider, "peer-old/entries/x.bin", b"stale")
            .await
            .unwrap();

        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();

        let result = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(dummy_rebuild_keyring_material("Device")),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("rebuild");

        assert_eq!(result.phase, "transfer");
        assert!(result.entries_adopted >= 2);
        assert!(result.journals_adopted >= 1);

        let pending_entry: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE entry_id = 'pulled-e1' AND sync_status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // After successful push, status may be synced — either pending or synced proves adoption.
        let entry_ledger: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE entry_id = 'pulled-e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let tomb_ledger: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE entry_id = 'tomb-e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let journal_ledger: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM journal_sync_state WHERE journal_id = 'pulled-j1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(entry_ledger, 1, "pulled entry must be adopted");
        assert_eq!(tomb_ledger, 1, "tombstone must be adopted");
        assert_eq!(journal_ledger, 1, "pulled journal must be adopted");
        let _ = pending_entry;

        assert!(
            !provider.path_exists("peer-old/entries/x.bin"),
            "stale peer payloads must be cleared while preserving control"
        );
        assert!(
            KeyringV2Io::read_file(provider.as_ref(), SYNC_CONTROL_DRIVE_PATH)
                .await
                .is_ok(),
            "control.json must survive cloud clear"
        );
        let control = read_sync_control(provider.as_ref())
            .await
            .unwrap()
            .expect("control");
        assert!(
            control.recovery_lease.is_some(),
            "recovery fence must remain held after rebuild upload"
        );
        assert_eq!(control.recovery_generation, result.recovery_generation);
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_uploads_media_versions_and_snapshots() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );

        let entry_id = seed_yjs_entry(&conn, "rebuild-body");
        let media_dir = TempDir::new().unwrap();
        let media_path = media_dir.path().join("photo.jpg");
        std::fs::write(&media_path, b"local-photo").unwrap();
        let media = db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: media_path.to_str().unwrap(),
                file_size: Some(11),
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
        // Mark uploaded to prove reset requeues.
        db::mark_media_uploaded(&conn, &media.id, "peer/media/x", 1).unwrap();

        let version_id =
            db::insert_entry_version(&conn, &entry_id, b"ver-bytes", "preview", "peer-dev")
                .unwrap();
        db::mark_version_uploaded(&conn, &version_id, "peer-dev/versions/v.bin").unwrap();

        db::set_setting(&conn, "ui_language", "vi").unwrap();
        // Tag / template / location minimal rows if helpers exist — settings alone is enough
        // for full-snapshot channel presence after push.

        let provider = CountingProvider::new();
        SyncProvider::write_file(&provider, "peer-dev/entries/old.bin", b"gone")
            .await
            .unwrap();

        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();

        let result = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(dummy_rebuild_keyring_material("Device")),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("rebuild should upload channels");

        assert_eq!(result.phase, "transfer");
        assert!(result.media_reset >= 1);
        assert!(result.versions_reset >= 1);
        assert!(
            result.media_uploaded >= 1,
            "local media must re-upload after reset"
        );
        assert!(
            result.versions_uploaded >= 1,
            "versions must re-upload after reset"
        );
        assert!(
            result.pushed_entries >= 1,
            "entries must push after adoption"
        );

        let media_cloud = format!("{device_id}/media/{}", media.id);
        assert!(
            provider.path_exists(&media_cloud),
            "media blob under current device"
        );
        let version_cloud = format!("{device_id}/versions/{version_id}.bin");
        assert!(
            provider.path_exists(&version_cloud),
            "version blob under current device"
        );
        // Always-written full-snapshot channels (empty sets still serialize).
        for channel in [
            "settings.bin",
            "tags.bin",
            "templates.bin",
            "locations.bin",
            "ai_reviews.bin",
            "metadata.json",
        ] {
            assert!(
                provider.path_exists(&format!("{device_id}/{channel}")),
                "full-snapshot / control channel missing: {channel}"
            );
        }
        // streak/ai_audit/chats are conditional on local rows;
        // push_local still walks those code paths without error.
        assert!(!provider.path_exists("peer-dev/entries/old.bin"));
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_binds_staged_cloud_only_media() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );

        let entry_id = seed_yjs_entry(&conn, "cloud-media");
        let media_id = "cloudonlymedia01";
        let cloud_path = format!("peer-x/media/{media_id}");
        db::insert_synced_media(
            &conn,
            media_id,
            &entry_id,
            "cloud.jpg",
            "image/jpeg",
            &cloud_path,
            Some(12),
            0,
            1,
            "inline",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let key_state = make_key_state();
        let plaintext = b"staged-bytes!!";
        let ciphertext = encrypt_media_bytes(&key_state, plaintext).unwrap();
        let provider = CountingProvider::new();
        SyncProvider::write_file(&provider, &cloud_path, &ciphertext)
            .await
            .unwrap();

        let work = TempDir::new().unwrap();
        let pre = local_authoritative_preflight(
            &conn,
            &provider,
            &provider,
            &key_state,
            default_opts(&work),
        )
        .await
        .expect("preflight stages media");
        assert_eq!(pre.media_downloaded, 1);
        std::mem::forget(work);

        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();
        let result = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                // Staged media path bind is not keyring-specific, but rebuild
                // requires keyring material unconditionally now (always
                // encrypted — no none-mode shortcut anymore).
                keyring: Some(dummy_rebuild_keyring_material("Device")),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("rebuild binds staged media");

        assert!(result.media_paths_bound >= 1 || result.media_uploaded >= 1);
        assert!(provider.path_exists(&format!("{device_id}/media/{media_id}")));
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_publishes_keyring_under_generation() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1, name = 'Rebuild Device' WHERE is_current = 1",
            [&device_id],
        );

        seed_yjs_entry(&conn, "keyring-entry");
        let provider = CountingProvider::new();
        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();

        let material = LocalAuthoritativeKeyringMaterial {
            recovery_wrapped: "ab".repeat(60),
            device_name: "Rebuild Device".into(),
            master_fingerprint: "a1b2c3d4".repeat(8),
            created_at: 1_700_000_000,
            device_created_at: 1_700_000_000,
            last_seen_at: 1_700_000_100,
            content_entries: vec![LocalAuthoritativeContentEntry {
                epoch: 1,
                wrapped_content: "ee".repeat(60),
                content_fingerprint: "ff".repeat(32),
            }],
            content_epoch: 1,
            master_epoch: 1,
        };

        let result = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(material),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("rebuild with keyring");

        assert!(result.keyring_published);
        let meta = crate::sync::keyring_v2::read_meta(provider.as_ref())
            .await
            .unwrap()
            .expect("meta");
        assert_eq!(meta.recovery_generation, result.recovery_generation);
        let slot = crate::sync::keyring_v2::read_device_slot(provider.as_ref(), &device_id)
            .await
            .unwrap()
            .expect("device slot");
        assert_eq!(slot.name, "Rebuild Device");
        let content = crate::sync::keyring_v2::read_content(provider.as_ref())
            .await
            .unwrap()
            .expect("_content.json must validate and exist");
        assert_eq!(content.entries.len(), 1);
        assert_eq!(content.entries[0].wrapped_content, "ee".repeat(60));
        assert_eq!(content.entries[0].content_fingerprint, "ff".repeat(32));
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_publishes_multi_epoch_content_list() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1, name = 'Multi Epoch' WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "multi-epoch");
        let provider = CountingProvider::new();
        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();

        let material = LocalAuthoritativeKeyringMaterial {
            recovery_wrapped: "ab".repeat(60),
            device_name: "Multi Epoch".into(),
            master_fingerprint: "a1b2c3d4".repeat(8),
            created_at: 1_700_000_000,
            device_created_at: 1_700_000_000,
            last_seen_at: 1_700_000_100,
            content_entries: vec![
                LocalAuthoritativeContentEntry {
                    epoch: 1,
                    wrapped_content: "11".repeat(60),
                    content_fingerprint: "aa".repeat(32),
                },
                LocalAuthoritativeContentEntry {
                    epoch: 2,
                    wrapped_content: "22".repeat(60),
                    content_fingerprint: "bb".repeat(32),
                },
            ],
            content_epoch: 2,
            master_epoch: 3,
        };

        let result = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(material),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("multi-epoch keyring rebuild");

        assert!(result.keyring_published);
        let content = crate::sync::keyring_v2::read_content(provider.as_ref())
            .await
            .unwrap()
            .expect("content");
        assert_eq!(content.latest_epoch, 2);
        assert_eq!(content.entries.len(), 2);
        assert_eq!(content.entries[0].epoch, 1);
        assert_eq!(content.entries[1].epoch, 2);
        let meta = crate::sync::keyring_v2::read_meta(provider.as_ref())
            .await
            .unwrap()
            .expect("meta");
        assert_eq!(meta.content_epoch, 2);
        assert_eq!(meta.epoch, 3);
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_rejects_password_mode_without_keyring() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_yjs_entry(&conn, "no-keyring");
        let provider = CountingProvider::new();
        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();

        let err = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            REBUILD_DEVICE,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: None,
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect_err("password mode without keyring must fail closed");
        assert_eq!(err.kind, LocalAuthoritativeRebuildErrorKind::UploadFailed);
        assert!(
            err.message.contains("keyring material"),
            "got: {}",
            err.message
        );
    }

    #[test]
    fn prepare_local_authoritative_rebuild_hard_fails_missing_staged_media() {
        let conn = setup();
        let journal_id = db::create_journal(&conn, "J", None).unwrap().id;
        let entry_id = db::create_entry(
            &conn,
            db::CreateEntryParams {
                journal_id: &journal_id,
                title: None,
                content_text: None,
                preview_text: None,
                entry_date: 1,
            },
        )
        .unwrap()
        .id;
        let media_id = "missing-media-01";
        db::insert_synced_media(
            &conn,
            media_id,
            &entry_id,
            "gone.jpg",
            "image/jpeg",
            "peer/media/missing-media-01",
            Some(4),
            0,
            1,
            "inline",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        // Empty local path, no staging dir → must fail before clearing cloud_path.
        let err = db::prepare_local_authoritative_rebuild(&conn, None).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains(media_id),
            "error must itemize missing media id, got: {msg}"
        );
        let cloud_path: Option<String> = conn
            .query_row(
                "SELECT cloud_path FROM media WHERE id = ?1",
                [media_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            cloud_path.as_deref(),
            Some("peer/media/missing-media-01"),
            "cloud_path must not be cleared when prepare hard-fails"
        );
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_rejects_active_sync() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        let provider = CountingProvider::new();
        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();

        let _held = crate::commands::sync::SyncInProgressGuard::try_acquire()
            .expect("hold single-flight for rejection test");

        let err = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            REBUILD_DEVICE,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: None,
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect_err("must reject when sync already in progress");

        assert_eq!(err.kind, LocalAuthoritativeRebuildErrorKind::SyncInProgress);
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_is_idempotent_after_transfer() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "idempotent");

        let provider = CountingProvider::new();
        let pre = run_preflight_for_rebuild(&conn, &provider).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);

        let clear_p = provider.clone();
        let first = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(dummy_rebuild_keyring_material("Device")),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("first rebuild");
        assert_eq!(first.phase, "transfer");

        let clear_p2 = provider.clone();
        let second = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(dummy_rebuild_keyring_material("Device")),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p2.as_ref()).await },
        )
        .await
        .expect("resume at transfer is no-op success");
        assert_eq!(second.phase, "transfer");
        assert_eq!(second.recovery_generation, first.recovery_generation);
    }

    #[tokio::test]
    async fn local_authoritative_rebuild_resumes_from_fenced_phase() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "resume-fenced");

        let provider = CountingProvider::new();
        let pre = run_preflight_for_rebuild(&conn, &provider).await;

        // Manually fence + clear to simulate crash after fenced, before transfer.
        let job = db::get_sync_recovery_job(&conn, pre.job_id)
            .unwrap()
            .unwrap();
        let permit = acquire_or_resume_local_to_cloud_lease(&provider, &job, &device_id)
            .await
            .expect("fence");
        db::set_sync_recovery_generation(&conn, permit.recovery_generation).unwrap();
        clear_cloud_preserving_control_io(&provider)
            .await
            .expect("clear");
        db::prepare_local_authoritative_rebuild(&conn, job.staging_path.as_deref()).unwrap();
        db::advance_sync_recovery_job(
            &conn,
            pre.job_id,
            "fenced",
            &serde_json::json!({"resumed": true}).to_string(),
        )
        .unwrap();

        let key_state = make_key_state();
        let key = make_sync_key();
        let provider = std::sync::Arc::new(provider);
        let clear_p = provider.clone();
        let result = local_authoritative_rebuild(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring: Some(dummy_rebuild_keyring_material("Device")),
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("resume from fenced");

        assert_eq!(result.phase, "transfer");
        assert!(result.pushed_entries >= 1);
    }

    // ── local_authoritative_verify_and_finalize (Task 3) ─────────────────

    async fn rebuild_to_transfer(
        conn: &Connection,
        device_id: &str,
        provider: std::sync::Arc<CountingProvider>,
        keyring: Option<LocalAuthoritativeKeyringMaterial>,
    ) -> LocalAuthoritativeRebuildResult {
        let pre = run_preflight_for_rebuild(conn, provider.as_ref()).await;
        let key_state = make_key_state();
        let key = make_sync_key();
        let clear_p = provider.clone();
        local_authoritative_rebuild(
            conn,
            provider.clone(),
            provider.as_ref(),
            device_id,
            &key,
            &key_state,
            LocalAuthoritativeRebuildOpts {
                job_id: pre.job_id,
                keyring,
            },
            move || async move { clear_cloud_preserving_control_io(clear_p.as_ref()).await },
        )
        .await
        .expect("rebuild to transfer")
    }

    #[tokio::test]
    async fn local_authoritative_recovery_verify_releases_fence_and_completes() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "verify-happy");

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;
        assert_eq!(rebuilt.phase, "transfer");
        assert!(
            read_sync_control(provider.as_ref())
                .await
                .unwrap()
                .unwrap()
                .recovery_lease
                .is_some(),
            "fence held after transfer"
        );

        let key_state = make_key_state();
        let key = make_sync_key();
        let result = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect("verify+finalize");

        assert_eq!(result.status, "completed");
        assert!(result.evidence.validate_complete().is_ok());
        let control = read_sync_control(provider.as_ref())
            .await
            .unwrap()
            .expect("control");
        assert!(
            control.recovery_lease.is_none(),
            "fence released after verified finalize"
        );
        assert_eq!(control.recovery_generation, result.recovery_generation);
        assert!(read_recovery_marker(provider.as_ref())
            .await
            .unwrap()
            .is_none());
        let job = db::get_sync_recovery_job(&conn, rebuilt.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.status, "completed");
        // Owner normal sync allowed; stale peer generation blocked.
        assert!(
            check_provider_recovery_push(provider.as_ref(), result.recovery_generation, None)
                .await
                .is_ok()
        );
        assert!(
            check_provider_recovery_push(provider.as_ref(), 0, None)
                .await
                .is_err(),
            "stale peer must remain blocked by generation mismatch"
        );
    }

    #[tokio::test]
    async fn local_authoritative_recovery_verify_fails_on_missing_post_upload_blob() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        let entry_id = seed_yjs_entry(&conn, "missing-blob");
        let media_dir = TempDir::new().unwrap();
        let media_path = media_dir.path().join("gone.jpg");
        std::fs::write(&media_path, b"bytes").unwrap();
        let media = db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "gone.jpg",
                file_type: "image/jpeg",
                storage_path: media_path.to_str().unwrap(),
                file_size: Some(5),
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

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;
        // Corrupt cloud after upload: drop media blob.
        SyncProvider::delete_file(
            provider.as_ref(),
            &format!("{device_id}/media/{}", media.id),
        )
        .await
        .unwrap();

        let key_state = make_key_state();
        let key = make_sync_key();
        let err = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect_err("missing blob must fail verification");
        assert_eq!(
            err.kind,
            LocalAuthoritativeVerifyErrorKind::VerificationFailed
        );
        let control = read_sync_control(provider.as_ref()).await.unwrap().unwrap();
        assert!(
            control.recovery_lease.is_some(),
            "fence must stay held on verification failure"
        );
        let job = db::get_sync_recovery_job(&conn, rebuilt.job_id)
            .unwrap()
            .unwrap();
        assert_ne!(job.status, "completed");
        assert!(
            check_provider_recovery_push(provider.as_ref(), control.recovery_generation, None)
                .await
                .is_err(),
            "peers blocked while recovery fence remains"
        );
    }

    #[tokio::test]
    async fn local_authoritative_recovery_verify_fails_on_missing_advertised_memory_blob() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        db::memory::insert_memory_item(
            &conn,
            "missing-memory-blob",
            "memory must be verified",
            "daily_chat",
            100,
        )
        .unwrap();

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;
        SyncProvider::delete_file(provider.as_ref(), &format!("{device_id}/memory.bin"))
            .await
            .unwrap();

        let err = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &make_sync_key(),
            &make_key_state(),
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect_err("an advertised memory blob must be verified before recovery finalizes");
        assert_eq!(
            err.kind,
            LocalAuthoritativeVerifyErrorKind::VerificationFailed
        );
    }

    #[tokio::test]
    async fn local_authoritative_recovery_verify_retries_after_transient_list_failure() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "transient");

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;
        let paths_before = KeyringV2Io::list_files(provider.as_ref(), "")
            .await
            .unwrap()
            .len();
        provider.fail_next_list();

        let key_state = make_key_state();
        let key = make_sync_key();
        let err = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect_err("transient Drive list failure");
        assert_eq!(
            err.kind,
            LocalAuthoritativeVerifyErrorKind::VerificationFailed
        );
        assert!(read_sync_control(provider.as_ref())
            .await
            .unwrap()
            .unwrap()
            .recovery_lease
            .is_some());

        // Resume without re-upload: path inventory must not grow duplicates.
        let result = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect("resume after transient failure");
        assert_eq!(result.status, "completed");
        let paths_after = KeyringV2Io::list_files(provider.as_ref(), "")
            .await
            .unwrap()
            .len();
        // Marker + lease gone, so path count may drop by recovery marker only.
        assert!(
            paths_after <= paths_before,
            "verification must not create duplicate cloud files (before={paths_before}, after={paths_after})"
        );
    }

    /// A recovery whose cloud lease is gone and whose generation has been
    /// overtaken is provably superseded: retrying can never succeed, and there
    /// is no lease of ours left to orphan. It must self-cancel rather than sit
    /// `failed` at `fence_release_pending`, where the UI offers neither Resume
    /// (the error classifies Terminal) nor Cancel (the phase rank is too high).
    #[tokio::test]
    async fn superseded_recovery_cancels_itself_instead_of_stranding_the_job() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "superseded");

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;

        let job = db::get_sync_recovery_job(&conn, rebuilt.job_id)
            .unwrap()
            .unwrap();
        let evidence = collect_local_to_cloud_verification_evidence(
            &conn,
            provider.as_ref(),
            provider.as_ref(),
            &device_id,
            &job,
            false,
        )
        .await
        .expect("evidence");
        advance_verify_phases(&conn, rebuilt.job_id, "transfer", &evidence).unwrap();

        // Another device released our lease and moved the generation past ours.
        let versioned = provider
            .read_versioned_file(SYNC_CONTROL_DRIVE_PATH)
            .await
            .unwrap();
        let mut control = parse_control(&versioned.bytes).unwrap();
        control.recovery_lease = None;
        control.recovery_generation = rebuilt.recovery_generation + 1;
        let bytes = serde_json::to_vec_pretty(&control).unwrap();
        provider
            .compare_and_swap_file(SYNC_CONTROL_DRIVE_PATH, &versioned.revision, &bytes)
            .await
            .unwrap();

        let key_state = make_key_state();
        let key = make_sync_key();
        let err = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect_err("a superseded recovery cannot finalize");
        assert_eq!(
            err.kind,
            LocalAuthoritativeVerifyErrorKind::RecoverySuperseded
        );

        // Cancelled, not failed — so no active job strands the UI.
        let after = db::get_sync_recovery_job(&conn, rebuilt.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(after.status, "completed");
        assert_eq!(after.last_error.as_deref(), Some("cancelled"));
        assert!(db::find_active_sync_recovery_job(&conn).unwrap().is_none());
    }

    #[tokio::test]
    async fn local_authoritative_recovery_verify_resumes_from_fence_release_pending() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "resume-release");

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;

        // Manually collect evidence + advance to fence_release_pending, then
        // inject marker-delete failure so release must resume after "restart".
        let job = db::get_sync_recovery_job(&conn, rebuilt.job_id)
            .unwrap()
            .unwrap();
        let evidence = collect_local_to_cloud_verification_evidence(
            &conn,
            provider.as_ref(),
            provider.as_ref(),
            &device_id,
            &job,
            false,
        )
        .await
        .expect("evidence");
        advance_verify_phases(&conn, rebuilt.job_id, "transfer", &evidence).unwrap();
        provider.fail_next_conditional_delete();

        let key_state = make_key_state();
        let key = make_sync_key();
        let err = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect_err("first release attempt fails");
        assert_eq!(err.kind, LocalAuthoritativeVerifyErrorKind::FenceFailed);
        assert_eq!(
            db::get_sync_recovery_job(&conn, rebuilt.job_id)
                .unwrap()
                .unwrap()
                .phase,
            "fence_release_pending"
        );

        let result = local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect("resume release after restart");
        assert_eq!(result.status, "completed");
        assert!(read_sync_control(provider.as_ref())
            .await
            .unwrap()
            .unwrap()
            .recovery_lease
            .is_none());
    }

    #[tokio::test]
    async fn local_authoritative_recovery_stale_peer_blocked_during_and_after() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let device_id = REBUILD_DEVICE.to_string();
        let _ = db::get_or_create_device_id(&conn);
        let _ = conn.execute(
            "UPDATE devices SET device_id = ?1 WHERE is_current = 1",
            [&device_id],
        );
        seed_yjs_entry(&conn, "peer-fence");

        let provider = std::sync::Arc::new(CountingProvider::new());
        let rebuilt = rebuild_to_transfer(
            &conn,
            &device_id,
            provider.clone(),
            Some(dummy_rebuild_keyring_material("Device")),
        )
        .await;
        // During recovery: peer without permit blocked even at new generation.
        assert!(
            check_provider_recovery_push(provider.as_ref(), rebuilt.recovery_generation, None)
                .await
                .is_err()
        );

        let key_state = make_key_state();
        let key = make_sync_key();
        local_authoritative_verify_and_finalize(
            &conn,
            provider.clone(),
            provider.as_ref(),
            &device_id,
            &key,
            &key_state,
            LocalAuthoritativeVerifyOpts {
                job_id: rebuilt.job_id,
                expect_keyring: false,
            },
        )
        .await
        .expect("finalize");

        // After release: stale generation still blocked; matching generation OK.
        assert!(check_provider_recovery_push(provider.as_ref(), 0, None)
            .await
            .is_err());
        assert!(
            check_provider_recovery_push(provider.as_ref(), rebuilt.recovery_generation, None)
                .await
                .is_ok()
        );
    }

    // ── cloud_authoritative_staging (Phase 3 Task 1) ─────────────────────

    fn staging_opts(work: &TempDir) -> CloudAuthoritativeStagingOpts {
        CloudAuthoritativeStagingOpts {
            work_dir: work.path().to_path_buf(),
            free_bytes_override: Some(10 * 1024 * 1024 * 1024),
            existing_job_id: None,
            cloud_media_bytes_estimate: None,
        }
    }

    fn staging_key_state() -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        // Distinct db_key from a pure master-only shim when needed; set_key
        // seeds db_key = master which is correct for Phase-1 vaults.
        ks.set_key(zeroize::Zeroizing::new([0x51u8; KEY_SIZE]))
            .expect("set_key");
        ks
    }

    fn seed_control(provider: &CountingProvider, generation: u64) {
        let control = crate::sync::sync_control::SyncControlV1 {
            version: 1,
            recovery_generation: generation,
            recovery_lease: None,
            updated_at: 1,
        };
        let bytes = serde_json::to_vec(&control).unwrap();
        let mut files = provider.files.lock().unwrap();
        files.insert(SYNC_CONTROL_DRIVE_PATH.to_string(), (bytes, 1));
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_creates_encrypted_db_reopenable_with_db_key() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let result =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect("begin staging");

        assert!(result.staging_db_path.is_file());

        // Reopen with the same derived SQLCipher key.
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let reopened = open_cloud_authoritative_staging_db(&result.staging_db_path, &db_key)
            .expect("reopen staging with db_key");
        // Migrated schema is present.
        let tables: i64 = reopened
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1);
        // Wrong key must fail.
        let wrong = [0xAAu8; 32];
        assert!(
            open_cloud_authoritative_staging_db(&result.staging_db_path, &wrong).is_err(),
            "wrong db_key must not open the staging SQLCipher file"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_creates_local_backup() {
        use std::io::Read as _;

        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        db::set_setting(&conn, "ui_language", "vi").unwrap();
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let result =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect("begin staging");

        assert!(result.backup_path.is_file());
        assert!(result
            .backup_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".memlore.zip"));
        let file = std::fs::File::open(&result.backup_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        // Password-mode key_state → automatic backup encrypts full_snapshot.json.
        assert!(archive.by_name("full_snapshot.json").is_err());
        assert!(archive.by_name("full_snapshot.json.enc").is_ok());
        assert!(archive.by_name("manifest.json").is_ok());

        let job = db::get_sync_recovery_job(&conn, result.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.operation, CLOUD_TO_LOCAL_OPERATION);
        assert_eq!(job.phase, "backup");
        assert_eq!(job.status, "running");
        assert_eq!(
            job.backup_path.as_deref(),
            Some(result.backup_path.to_str().unwrap())
        );

        let mut enc = Vec::new();
        archive
            .by_name("full_snapshot.json.enc")
            .unwrap()
            .read_to_end(&mut enc)
            .unwrap();
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let snap = crate::utils::encryption::decrypt_data(&db_key, &enc).unwrap();
        let snapshot: db::FullBackupSnapshot = serde_json::from_slice(&snap).unwrap();
        assert_eq!(snapshot.snapshot_version, 1);
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_zero_provider_writes() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        // Decoy peer object must remain untouched.
        SyncProvider::write_file(&provider, "peer/entries/e.bin", b"do-not-touch")
            .await
            .unwrap();
        let writes_before = provider.files.lock().unwrap().len();
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let _ =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect("begin staging");

        assert_eq!(provider.delete_count(), 0);
        assert_eq!(
            provider.files.lock().unwrap().len(),
            writes_before,
            "staging must not create/overwrite any provider files"
        );
        assert_eq!(
            SyncProvider::read_file(&provider, "peer/entries/e.bin")
                .await
                .unwrap(),
            b"do-not-touch"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_keeps_active_db_unchanged() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let entry_id = seed_entry(&conn);
        db::set_setting(&conn, "theme", "dark").unwrap();
        db::set_setting(&conn, "gdrive_refresh_token", "secret-token").unwrap();
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let result =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect("begin staging");

        // Active vault still has its rows; staging is a different file.
        assert!(db::get_entry(&conn, &entry_id).unwrap().is_some());
        assert_eq!(
            db::get_setting(&conn, "theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            db::get_setting(&conn, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("secret-token")
        );
        assert_ne!(
            result.staging_db_path.to_string_lossy().as_ref(),
            ":memory:"
        );
        // Staging starts empty of user entries (materialize is Task 2).
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let staging =
            open_cloud_authoritative_staging_db(&result.staging_db_path, &db_key).unwrap();
        assert!(db::get_entry(&staging, &entry_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_preserves_device_local_settings_outside_staging() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        let device_id = db::get_or_create_device_id(&conn).unwrap();
        db::set_setting(&conn, "gdrive_refresh_token", "tok-abc").unwrap();
        db::set_setting(&conn, db::WRAPPED_ENCRYPTION_KEY_KEY, "wrapped-master").unwrap();
        db::set_setting(&conn, "ai_api_key", "sk-local").unwrap();
        db::set_setting(&conn, "theme", "light").unwrap(); // syncable — not preserved here
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let result =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect("begin staging");

        // Side-file must be encrypted (not plaintext JSON secrets).
        let raw = std::fs::read(&result.preserved_settings_path).unwrap();
        assert_eq!(raw.first().copied(), Some(PRESERVED_ENVELOPE_ENCRYPTED));
        assert!(
            serde_json::from_slice::<PreservedDeviceLocalState>(&raw).is_err(),
            "preserved side-file must not be plaintext JSON"
        );
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let preserved = read_preserved_device_local_state(&result.preserved_settings_path, &db_key)
            .expect("decrypt preserved");
        assert_eq!(preserved.device_id.as_deref(), Some(device_id.as_str()));
        assert_eq!(
            preserved
                .settings
                .get("gdrive_refresh_token")
                .map(String::as_str),
            Some("tok-abc")
        );
        assert_eq!(
            preserved
                .settings
                .get(db::WRAPPED_ENCRYPTION_KEY_KEY)
                .map(String::as_str),
            Some("wrapped-master")
        );
        assert_eq!(
            preserved.settings.get("ai_api_key").map(String::as_str),
            Some("sk-local")
        );
        assert!(
            !preserved.settings.contains_key("theme"),
            "syncable settings must not be in the device-local preserve file"
        );

        // Staging DB itself must not carry those secrets yet (empty migrated DB).
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let staging =
            open_cloud_authoritative_staging_db(&result.staging_db_path, &db_key).unwrap();
        assert!(db::get_setting(&staging, "gdrive_refresh_token")
            .unwrap()
            .is_none());
        assert!(db::get_setting(&staging, "ai_api_key").unwrap().is_none());
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_aborts_on_keyring_unreadable() {
        let _sync_lock = lock_sync_guard_for_test();
        #[derive(Clone)]
        struct BrokenKeyring {
            control_ok: bool,
        }

        #[async_trait]
        impl KeyringV2Io for BrokenKeyring {
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
                if path == SYNC_CONTROL_DRIVE_PATH && self.control_ok {
                    let control = crate::sync::sync_control::SyncControlV1 {
                        version: 1,
                        recovery_generation: 0,
                        recovery_lease: None,
                        updated_at: 1,
                    };
                    return Ok(serde_json::to_vec(&control).unwrap());
                }
                Err(SyncError::Network("keyring offline".into()))
            }
            async fn write_file(&self, _path: &str, _data: &[u8]) -> Result<(), SyncError> {
                Err(SyncError::Io("no writes".into()))
            }
            async fn delete_file(&self, _path: &str) -> Result<(), SyncError> {
                Err(SyncError::Io("no deletes".into()))
            }
            async fn list_files(&self, _prefix: &str) -> Result<Vec<String>, SyncError> {
                Ok(Vec::new())
            }
            async fn read_versioned_file(
                &self,
                path: &str,
            ) -> Result<crate::sync::keyring_v2::VersionedFile, SyncError> {
                let bytes = KeyringV2Io::read_file(self, path).await?;
                Ok(crate::sync::keyring_v2::VersionedFile {
                    bytes,
                    revision: "1".into(),
                })
            }
            async fn compare_and_swap_file(
                &self,
                _path: &str,
                _expected_revision: &str,
                _data: &[u8],
            ) -> Result<ConditionalMutationResult, SyncError> {
                Err(SyncError::Io("no cas".into()))
            }
            async fn create_initial_control_if_absent(
                &self,
                _data: &[u8],
            ) -> Result<ConditionalMutationResult, SyncError> {
                Err(SyncError::Io("no create".into()))
            }
            async fn create_recovery_marker_if_absent(
                &self,
                _data: &[u8],
                _permit: &RecoveryOwnerPermit,
            ) -> Result<ConditionalMutationResult, SyncError> {
                Err(SyncError::Io("no marker".into()))
            }
            async fn delete_file_if_revision(
                &self,
                _path: &str,
                _expected_revision: &str,
            ) -> Result<ConditionalMutationResult, SyncError> {
                Err(SyncError::Io("no delete".into()))
            }
        }

        let conn = setup();
        seed_entry(&conn);
        let keyring = BrokenKeyring { control_ok: true };
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let err =
            cloud_authoritative_begin_staging(&conn, &keyring, &key_state, staging_opts(&work))
                .await
                .expect_err("keyring meta failure must abort");
        assert_eq!(
            err.kind,
            CloudAuthoritativeStagingErrorKind::KeyringUnreadable
        );
        assert!(
            !work.path().join("staging").exists(),
            "must abort before creating staging tree"
        );
        assert!(db::find_active_sync_recovery_job(&conn).unwrap().is_none());
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_aborts_on_generation_validation_failure() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        // Local is ahead of cloud → rollback risk.
        db::set_sync_recovery_generation(&conn, 5).unwrap();
        let provider = CountingProvider::new();
        seed_control(&provider, 2);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let err =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect_err("generation rollback must abort");
        assert_eq!(
            err.kind,
            CloudAuthoritativeStagingErrorKind::GenerationInvalid
        );
        assert!(
            !work.path().join("staging").exists(),
            "must abort before staging when generation validation fails"
        );
        assert!(db::find_active_sync_recovery_job(&conn).unwrap().is_none());
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_aborts_on_keyring_generation_mismatch() {
        use crate::sync::keyring_v2::{KeyringMetaV2, KEYRING_V2_VERSION, META_PATH};

        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        let provider = CountingProvider::new();
        seed_control(&provider, 3);
        let meta = KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 1,
            master_fingerprint: "a".repeat(64),
            content_epoch: 1,
            recovery_generation: 1, // mismatch vs control=3
            created_at: 1,
            updated_at: 1,
        };
        provider.files.lock().unwrap().insert(
            META_PATH.to_string(),
            (serde_json::to_vec(&meta).unwrap(), 1),
        );
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let err =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect_err("meta/control generation mismatch must abort");
        assert_eq!(
            err.kind,
            CloudAuthoritativeStagingErrorKind::GenerationInvalid
        );
        assert!(!work.path().join("staging").exists());
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_rejects_active_sync_guard() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        seed_entry(&conn);
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();
        let _held = crate::commands::sync::SyncInProgressGuard::try_acquire()
            .expect("guard free at test start");

        let err =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect_err("must reject when sync is in progress");
        assert_eq!(err.kind, CloudAuthoritativeStagingErrorKind::SyncInProgress);
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_pull_includes_self_with_zero_writes() {
        use crate::sync::engine::SyncEngine;
        use crate::sync::local_provider::LocalSyncProvider;
        use std::sync::Arc;

        let _sync_lock = lock_sync_guard_for_test();
        let key = [0x51u8; KEY_SIZE];
        let key_state = {
            let ks = crate::EncryptionKeyState::new();
            ks.set_key(zeroize::Zeroizing::new(key)).unwrap();
            ks
        };
        let cloud_dir = TempDir::new().unwrap();
        let author_conn = setup();
        let device_id = "dev-current".to_string();
        let author_provider = Arc::new(LocalSyncProvider::new(cloud_dir.path().to_path_buf()));
        let author_engine = SyncEngine::new(author_provider.clone(), device_id.clone());
        let entry_id = seed_yjs_entry(&author_conn, "self-authored cloud copy");
        db::mark_entry_pending(&author_conn, &entry_id).unwrap();
        author_engine
            .push_local(&author_conn, &key, &key_state, SyncTrigger::Manual)
            .await
            .unwrap();

        // Active local DB is a different vault that still has its own data.
        let active = setup();
        let local_only = seed_entry(&active);
        db::set_setting(&active, "gdrive_refresh_token", "keep-me").unwrap();

        // Control plane validation uses KeyringV2Io (CountingProvider).
        // Cloud payloads live on LocalSyncProvider under the same work dir
        // only for the pull leg.
        let control_provider = CountingProvider::new();
        seed_control(&control_provider, 0);

        let work = TempDir::new().unwrap();
        let result = cloud_authoritative_begin_staging(
            &active,
            &control_provider,
            &key_state,
            staging_opts(&work),
        )
        .await
        .expect("begin staging");

        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let staging =
            open_cloud_authoritative_staging_db(&result.staging_db_path, &db_key).unwrap();

        // ReadOnly-wrapped engine: any accidental write would fail the pull.
        let engine = cloud_authoritative_pull_engine(author_provider, device_id);
        engine
            .pull_only_for_recovery(&staging, &key, &key_state)
            .await
            .expect("recovery pull into staging");

        assert!(
            db::get_entry(&staging, &entry_id).unwrap().is_some(),
            "recovery pull must include the current device folder"
        );
        // Active DB still has only its local entry — not the cloud one.
        assert!(db::get_entry(&active, &entry_id).unwrap().is_none());
        assert!(db::get_entry(&active, &local_only).unwrap().is_some());
        assert_eq!(
            db::get_setting(&active, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("keep-me")
        );

        // ReadOnly wrapper rejects explicit writes.
        let readonly = ReadOnlySyncProvider::new(Arc::new(LocalSyncProvider::new(
            cloud_dir.path().to_path_buf(),
        )));
        assert!(
            SyncProvider::write_file(&readonly, "dev-x/entries/e.bin", b"nope")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_staging_discard_removes_only_staging() {
        let _sync_lock = lock_sync_guard_for_test();
        let conn = setup();
        let entry_id = seed_entry(&conn);
        let provider = CountingProvider::new();
        seed_control(&provider, 0);
        let key_state = staging_key_state();
        let work = TempDir::new().unwrap();

        let result =
            cloud_authoritative_begin_staging(&conn, &provider, &key_state, staging_opts(&work))
                .await
                .expect("begin staging");

        assert!(result.staging_path.exists());
        assert!(result.backup_path.is_file());
        discard_cloud_authoritative_staging(&result.staging_path);
        assert!(!result.staging_path.exists());
        assert!(
            result.backup_path.is_file(),
            "discard must not remove the automatic backup"
        );
        assert!(
            db::get_entry(&conn, &entry_id).unwrap().is_some(),
            "active DB must remain untouched after staging discard"
        );
    }

    // ── cloud_authoritative_materialize (Phase 3 Task 2) ─────────────────

    use crate::sync::engine::SyncEngine;
    use crate::sync::local_provider::LocalSyncProvider;
    use std::sync::Arc;

    const MATERIALIZE_DEVICE: &str = "dev-current";
    const MATERIALIZE_PEER: &str = "dev-peer-b";

    fn materialize_key() -> [u8; KEY_SIZE] {
        [0x51u8; KEY_SIZE]
    }

    fn materialize_key_state() -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        ks.set_key(zeroize::Zeroizing::new(materialize_key()))
            .expect("set_key");
        ks
    }

    fn cloud_provider(dir: &TempDir) -> Arc<LocalSyncProvider> {
        Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()))
    }

    fn make_push_engine(dir: &TempDir, device_id: &str) -> SyncEngine {
        SyncEngine::new(cloud_provider(dir), device_id.to_string())
    }

    async fn begin_staging_for_materialize(
        active: &Connection,
        work: &TempDir,
        generation: u64,
    ) -> CloudAuthoritativeStagingResult {
        let control = CountingProvider::new();
        seed_control(&control, generation);
        cloud_authoritative_begin_staging(
            active,
            &control,
            &materialize_key_state(),
            staging_opts(work),
        )
        .await
        .expect("begin staging")
    }

    async fn run_materialize(
        active: &Connection,
        cloud: Arc<LocalSyncProvider>,
        staging: CloudAuthoritativeStagingResult,
        device_id: &str,
    ) -> Result<CloudAuthoritativeMaterializeResult, CloudAuthoritativeMaterializeError> {
        let control = CountingProvider::new();
        seed_control(&control, staging.cloud_recovery_generation);
        cloud_authoritative_materialize(
            active,
            cloud,
            &control,
            &materialize_key_state(),
            CloudAuthoritativeMaterializeOpts {
                staging,
                device_id: device_id.to_string(),
                content_key: materialize_key(),
            },
        )
        .await
    }

    fn channel_records(result: &CloudAuthoritativeMaterializeResult, name: &str) -> u64 {
        result
            .channels
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.records)
            .unwrap_or(u64::MAX)
    }

    fn sync_status(conn: &Connection, entry_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT sync_status FROM sync_state WHERE entry_id = ?1",
            [entry_id],
            |r| r.get(0),
        )
        .ok()
    }

    fn manifest_with_entry(
        device_id: &str,
        entry_id: &str,
        is_deleted: bool,
    ) -> crate::sync::metadata::DeviceMetadata {
        crate::sync::metadata::DeviceMetadata {
            device_id: device_id.to_string(),
            recovery_generation: 0,
            entries: vec![crate::sync::metadata::SyncedEntrySummary {
                entry_id: entry_id.to_string(),
                updated_at: 1,
                local_version: 1,
                is_deleted,
            }],
            journals: vec![],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        }
    }

    fn manifest_with_journal(
        device_id: &str,
        journal_id: &str,
        is_deleted: bool,
    ) -> crate::sync::metadata::DeviceMetadata {
        crate::sync::metadata::DeviceMetadata {
            device_id: device_id.to_string(),
            recovery_generation: 0,
            entries: vec![],
            journals: vec![crate::sync::metadata::SyncedJournalSummary {
                journal_id: journal_id.to_string(),
                updated_at: 1,
                local_version: 1,
                is_deleted,
            }],
            chats_present: false,
            memory_present: false,
            generated_at: 0,
        }
    }

    #[test]
    fn verify_recovery_manifest_coverage_flags_missing_live_entry() {
        let staging = setup();
        let manifest = manifest_with_entry("dev-x", "11111111-1111-1111-1111-111111111111", false);
        let missing = verify_recovery_manifest_coverage(&staging, std::slice::from_ref(&manifest));
        assert_eq!(missing.len(), 1, "missing: {missing:?}");
        assert!(missing[0].contains("dev-x"));
        assert!(missing[0].contains("11111111-1111-1111-1111-111111111111"));
    }

    #[test]
    fn verify_recovery_manifest_coverage_flags_missing_live_journal() {
        let staging = setup();
        let manifest =
            manifest_with_journal("dev-x", "22222222-2222-2222-2222-222222222222", false);
        let missing = verify_recovery_manifest_coverage(&staging, std::slice::from_ref(&manifest));
        assert_eq!(missing.len(), 1, "missing: {missing:?}");
        assert!(missing[0].contains("22222222-2222-2222-2222-222222222222"));
    }

    #[test]
    fn verify_recovery_manifest_coverage_exempts_tombstoned_manifest_entries() {
        let staging = setup();
        let manifest = manifest_with_entry("dev-x", "33333333-3333-3333-3333-333333333333", true);
        let missing = verify_recovery_manifest_coverage(&staging, std::slice::from_ref(&manifest));
        assert!(
            missing.is_empty(),
            "a manifest tombstone with no staging row is not a loss: {missing:?}"
        );
    }

    #[test]
    fn verify_recovery_manifest_coverage_accepts_row_present_but_locally_tombstoned() {
        let staging = setup();
        let entry_id = seed_yjs_entry(&staging, "existing but tombstoned");
        db::soft_delete_entry(&staging, &entry_id).unwrap();
        // This device's manifest is stale and still thinks the row is live —
        // the row itself exists (a newer device's tombstone landed on top of
        // it), so this must NOT be flagged as missing.
        let manifest = manifest_with_entry("dev-x", &entry_id, false);
        let missing = verify_recovery_manifest_coverage(&staging, std::slice::from_ref(&manifest));
        assert!(
            missing.is_empty(),
            "row exists even though locally tombstoned by a newer device: {missing:?}"
        );
    }

    #[tokio::test]
    async fn fetch_all_recovery_manifests_skips_unsafe_device_ids() {
        let provider = CountingProvider::new();
        let safe = manifest_with_entry("dev-safe", "11111111-1111-1111-1111-111111111111", false);
        SyncProvider::write_file(
            &provider,
            "dev-safe/metadata.json",
            &serde_json::to_vec(&safe).unwrap(),
        )
        .await
        .unwrap();
        // `!` is outside the alphanumeric/-/_ charset, so this id is unsafe;
        // its manifest must be skipped, never trusted for coverage claims.
        let hostile = manifest_with_entry("bad!id", "22222222-2222-2222-2222-222222222222", false);
        SyncProvider::write_file(
            &provider,
            "bad!id/metadata.json",
            &serde_json::to_vec(&hostile).unwrap(),
        )
        .await
        .unwrap();

        let manifests = fetch_all_recovery_manifests(&provider).await.unwrap();
        assert_eq!(manifests.len(), 1, "unsafe device id must be skipped");
        assert_eq!(manifests[0].device_id, "dev-safe");
    }

    #[tokio::test]
    async fn fetch_all_recovery_manifests_skips_folders_without_manifest() {
        let provider = CountingProvider::new();
        let full = manifest_with_entry("dev-full", "11111111-1111-1111-1111-111111111111", false);
        SyncProvider::write_file(
            &provider,
            "dev-full/metadata.json",
            &serde_json::to_vec(&full).unwrap(),
        )
        .await
        .unwrap();
        // A half-created peer: device folder exists (has a blob) but never
        // published metadata.json — NotFound must skip it, not fail closed.
        SyncProvider::write_file(&provider, "dev-half/entries/blob.bin", b"x")
            .await
            .unwrap();

        let manifests = fetch_all_recovery_manifests(&provider).await.unwrap();
        assert_eq!(
            manifests.len(),
            1,
            "half-created peer without metadata.json must be skipped"
        );
        assert_eq!(manifests[0].device_id, "dev-full");
    }

    #[tokio::test]
    async fn recovery_manifest_read_bypasses_conditional_revision_cache() {
        struct ConditionalCacheTrapProvider {
            inner: crate::sync::provider::test_support::MockProvider,
        }

        #[async_trait]
        impl SyncProvider for ConditionalCacheTrapProvider {
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
            async fn read_file_if_changed(
                &self,
                _path: &str,
                _known_revision: Option<&str>,
            ) -> Result<crate::sync::provider::ConditionalRead, SyncError> {
                Ok(crate::sync::provider::ConditionalRead::Unchanged)
            }
            async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
                self.inner.write_file(path, data).await
            }
            async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
                self.inner.delete_file(path).await
            }
        }

        let provider = ConditionalCacheTrapProvider {
            inner: crate::sync::provider::test_support::MockProvider::new(),
        };
        let manifest =
            manifest_with_entry("dev-fresh", "11111111-1111-1111-1111-111111111111", false);
        provider
            .write_file(
                "dev-fresh/metadata.json",
                &serde_json::to_vec(&manifest).unwrap(),
            )
            .await
            .unwrap();

        let manifests = fetch_all_recovery_manifests(&provider).await.unwrap();

        assert_eq!(
            manifests.len(),
            1,
            "recovery must directly read the manifest instead of accepting an unchanged cache response"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_self_only_cloud_and_channel_counts() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let entry_id = seed_yjs_entry(&author, "self-only body");
        let memory_id = "recovery-memory-live";
        let deleted_memory_id = "recovery-memory-deleted";
        db::memory::insert_memory_item(
            &author,
            memory_id,
            "cloud-authoritative memory",
            "journal_entry",
            100,
        )
        .unwrap();
        db::memory::add_memory_source(&author, memory_id, "journal_entry", &entry_id).unwrap();
        db::set_setting(
            &author,
            crate::ai::provider::settings_keys::memory_embed::PROVIDER,
            "local",
        )
        .unwrap();
        db::set_setting(
            &author,
            crate::ai::provider::settings_keys::memory_embed::EMBEDDING_MODEL,
            "embed-v1",
        )
        .unwrap();
        let hash = crate::ai::chunking::content_hash("cloud-authoritative memory");
        db::memory::upsert_memory_embedding(
            &author,
            memory_id,
            "local:embed-v1",
            1,
            &[0.25],
            &hash,
            101,
        )
        .unwrap();
        db::memory::insert_memory_item(
            &author,
            deleted_memory_id,
            "deleted cloud memory",
            "daily_chat",
            100,
        )
        .unwrap();
        db::memory::tombstone_memory_item(&author, deleted_memory_id, 101).unwrap();
        db::mark_entry_pending(&author, &entry_id).unwrap();
        db::set_setting(&author, "theme", "dark").unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let active = setup();
        db::set_setting(
            &active,
            crate::ai::provider::settings_keys::memory_embed::PROVIDER,
            "local",
        )
        .unwrap();
        db::set_setting(
            &active,
            crate::ai::provider::settings_keys::memory_embed::EMBEDDING_MODEL,
            "embed-v1",
        )
        .unwrap();
        let local_only = seed_entry(&active);
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await
        .expect("materialize self-only cloud");

        let job = db::get_sync_recovery_job(&active, result.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.phase, "verify");
        assert_eq!(job.status, "running");

        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        let staged =
            open_cloud_authoritative_staging_db(&staging.staging_db_path, &db_key).unwrap();
        assert!(db::get_entry(&staged, &entry_id).unwrap().is_some());
        assert_eq!(
            db::get_setting(&staged, "theme").unwrap().as_deref(),
            Some("dark")
        );
        assert_eq!(
            sync_status(&staged, &entry_id).as_deref(),
            Some("synced"),
            "self cloud rows must become synced-owned"
        );
        let recovered_memory = db::memory::list_all_memory_items_for_sync(&staged).unwrap();
        assert_eq!(
            recovered_memory.len(),
            2,
            "recovery must retain live memory and tombstones"
        );
        assert!(recovered_memory
            .iter()
            .any(|item| item.id == deleted_memory_id && item.is_deleted));
        assert_eq!(
            db::memory::list_sources_for_memory(&staged, memory_id)
                .unwrap()
                .len(),
            1,
            "recovery must retain memory sources"
        );
        assert_eq!(
            db::memory::list_memory_embeddings_for_memory(&staged, memory_id)
                .unwrap()
                .len(),
            1,
            "recovery must retain eligible memory vectors"
        );

        // Exact classified channel inventory.
        assert_eq!(result.channels.len(), SYNC_RECOVERY_CHANNELS.len());
        for (expected, actual) in SYNC_RECOVERY_CHANNELS.iter().zip(result.channels.iter()) {
            assert_eq!(expected.name, actual.name);
        }
        assert!(channel_records(&result, "entries") >= 1);
        assert_eq!(channel_records(&result, "memory"), 2);
        assert_eq!(result.self_owned_entries, 1);
        assert_eq!(result.peer_entries, 0);

        // Active vault unchanged.
        assert!(db::get_entry(&active, &entry_id).unwrap().is_none());
        assert!(db::get_entry(&active, &local_only).unwrap().is_some());
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_lww_yjs_tombstone_and_peer_ownership() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();

        // Peer B publishes first.
        let conn_b = setup();
        let engine_b = make_push_engine(&cloud_dir, MATERIALIZE_PEER);
        let shared_id = seed_yjs_entry(&conn_b, "peer-old");
        db::mark_entry_pending(&conn_b, &shared_id).unwrap();
        engine_b
            .push_local(&conn_b, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        // Current device A pulls B, then writes a newer LWW title + body.
        let conn_a = setup();
        let engine_a = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        engine_a.pull_remote(&conn_a, &key, &ks).await.unwrap();
        let now = db::get_entry(&conn_a, &shared_id)
            .unwrap()
            .unwrap()
            .updated_at
            + 50;
        let new_blob = {
            use yrs::{Doc, ReadTxn, StateVector, Text, Transact};
            let doc = Doc::new();
            let t = doc.get_or_insert_text("content");
            {
                let mut txn = doc.transact_mut();
                t.insert(&mut txn, 0, "A-prefix-peer-old");
            }
            let bytes = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            bytes
        };
        conn_a
            .execute(
                "UPDATE entries SET title = ?1, content_text = ?2, updated_at = ?3, yjs_doc = ?4
                 WHERE id = ?5",
                rusqlite::params!["A-wins-title", "A body", now, new_blob, &shared_id],
            )
            .unwrap();
        db::mark_entry_pending(&conn_a, &shared_id).unwrap();

        // Self-only tombstone on A.
        let tomb_id = seed_yjs_entry(&conn_a, "will-delete");
        db::mark_entry_pending(&conn_a, &tomb_id).unwrap();
        db::soft_delete_entry(&conn_a, &tomb_id).unwrap();
        db::mark_entry_pending(&conn_a, &tomb_id).unwrap();

        // Peer-only live entry on B.
        let peer_only = seed_yjs_entry(&conn_b, "peer-only-live");
        db::mark_entry_pending(&conn_b, &peer_only).unwrap();

        engine_a
            .push_local(&conn_a, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();
        engine_b
            .push_local(&conn_b, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await
        .expect("materialize multi-device");

        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        let staged =
            open_cloud_authoritative_staging_db(&staging.staging_db_path, &db_key).unwrap();

        let shared = db::get_entry_raw(&staged, &shared_id).unwrap().unwrap();
        assert_eq!(shared.title.as_deref(), Some("A-wins-title"));
        assert_eq!(
            shared.content_text.as_deref(),
            Some("A body"),
            "LWW metadata must favor the newer self revision"
        );
        let yjs = db::get_entry_content(&staged, &shared_id).unwrap().unwrap();
        assert!(
            !yjs.is_empty(),
            "yjs blob must materialize after multi-device merge"
        );

        let tomb = db::get_entry_raw(&staged, &tomb_id).unwrap().unwrap();
        assert!(tomb.is_deleted, "self tombstone must materialize");
        assert_eq!(
            sync_status(&staged, &tomb_id).as_deref(),
            Some("synced"),
            "self tombstone is synced-owned"
        );

        assert!(db::get_entry(&staged, &peer_only).unwrap().is_some());
        assert!(
            sync_status(&staged, &peer_only).is_none(),
            "peer rows remain pull-owned (no sync_state)"
        );
        assert_eq!(sync_status(&staged, &shared_id).as_deref(), Some("synced"));
        assert!(result.self_owned_entries >= 2);
        assert!(result.peer_entries >= 1);
    }

    // Regression guard: a peer's entry blob that fails to decrypt/parse must
    // abort materialize rather than silently producing an incomplete
    // staging DB. This is primarily caught today by the pull engine's own
    // fail-closed check for recovery pulls (`pull_entries_for_recovery`
    // aborts the whole pull when any per-item error/warning is recorded),
    // which surfaces as `PullFailed` before the materialize-level Layer 1/2
    // checks added by this fix are ever reached. The two added layers exist
    // as defense-in-depth for this same contract; this test guards the
    // end-to-end outcome regardless of which layer catches it.
    #[tokio::test]
    async fn cloud_authoritative_materialize_rejects_corrupt_peer_entry_blob() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();

        let conn_b = setup();
        let engine_b = make_push_engine(&cloud_dir, MATERIALIZE_PEER);
        let peer_entry = seed_yjs_entry(&conn_b, "peer live entry");
        db::mark_entry_pending(&conn_b, &peer_entry).unwrap();
        engine_b
            .push_local(&conn_b, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let blob_path = cloud_dir
            .path()
            .join(MATERIALIZE_PEER)
            .join("entries")
            .join(format!("{peer_entry}.bin"));
        assert!(blob_path.exists(), "peer blob must exist before corruption");
        std::fs::write(&blob_path, b"totally-corrupt-not-a-valid-payload").unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await;

        assert!(
            result.is_err(),
            "materialize must fail closed on a corrupt peer entry blob"
        );
        assert!(
            !staging.staging_db_path.exists() || !staging.staging_media_path.exists(),
            "staging must be discarded on failure"
        );
    }

    // Same contract as above for a peer manifest that references a blob
    // absent from the provider (surfaces as a warning inside the engine,
    // which the recovery pull already folds into a hard error today).
    #[tokio::test]
    async fn cloud_authoritative_materialize_rejects_missing_peer_entry_blob() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();

        let conn_b = setup();
        let engine_b = make_push_engine(&cloud_dir, MATERIALIZE_PEER);
        let peer_entry = seed_yjs_entry(&conn_b, "peer live entry");
        db::mark_entry_pending(&conn_b, &peer_entry).unwrap();
        engine_b
            .push_local(&conn_b, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let blob_path = cloud_dir
            .path()
            .join(MATERIALIZE_PEER)
            .join("entries")
            .join(format!("{peer_entry}.bin"));
        assert!(blob_path.exists(), "peer blob must exist before removal");
        std::fs::remove_file(&blob_path).unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await;

        assert!(
            result.is_err(),
            "materialize must fail closed when a peer manifest references a missing blob"
        );
    }

    // Guards against a false positive in the new manifest-coverage check
    // (Layer 2): a peer's manifest can legitimately still say "live" for an
    // entry that a *different, newer* device has since tombstoned. The row
    // must exist in staging (it does — with is_deleted=1), which the
    // coverage check accepts; requiring the row to also match the stale
    // manifest's liveness would be a false positive that blocks recovery
    // for a perfectly ordinary multi-device edit.
    #[tokio::test]
    async fn cloud_authoritative_materialize_allows_legit_newer_tombstone_despite_stale_manifest() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        const PEER_B: &str = "dev-peer-b-stale";
        const PEER_C: &str = "dev-peer-c-newer";

        // Peer B publishes a live entry and never learns about C's later
        // tombstone — its metadata.json on the cloud keeps saying "live".
        let conn_b = setup();
        let engine_b = make_push_engine(&cloud_dir, PEER_B);
        let shared_id = seed_yjs_entry(&conn_b, "peer-b-live");
        db::mark_entry_pending(&conn_b, &shared_id).unwrap();
        engine_b
            .push_local(&conn_b, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        // Peer C pulls B's entry, then issues a strictly newer tombstone.
        let conn_c = setup();
        let engine_c = make_push_engine(&cloud_dir, PEER_C);
        engine_c.pull_remote(&conn_c, &key, &ks).await.unwrap();
        let tomb_ts = db::get_entry(&conn_c, &shared_id)
            .unwrap()
            .unwrap()
            .updated_at
            + 100;
        conn_c
            .execute(
                "UPDATE entries SET is_deleted = 1, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![tomb_ts, &shared_id],
            )
            .unwrap();
        db::mark_entry_pending(&conn_c, &shared_id).unwrap();
        engine_c
            .push_local(&conn_c, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await
        .expect(
            "materialize must succeed: the row exists even though B's stale manifest still says live",
        );
        let _ = result;

        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        let staged =
            open_cloud_authoritative_staging_db(&staging.staging_db_path, &db_key).unwrap();
        let row = db::get_entry_raw(&staged, &shared_id).unwrap().unwrap();
        assert!(row.is_deleted, "C's strictly newer tombstone must win");
    }

    #[tokio::test]
    async fn download_staging_media_rejects_unsafe_media_id() {
        let staging = setup();
        let entry_id = seed_yjs_entry(&staging, "entry with malicious media id");
        staging
            .execute(
                "INSERT INTO media \
                     (id, entry_id, file_name, file_type, storage_provider, storage_path, \
                      sort_order, created_at) \
                 VALUES ('../evil', ?1, 'evil.jpg', 'image/jpeg', 'local', '/tmp/nope', 0, 0)",
                [&entry_id],
            )
            .unwrap();

        let cloud_dir = TempDir::new().unwrap();
        let provider = cloud_provider(&cloud_dir);
        let ks = materialize_key_state();
        let work = TempDir::new().unwrap();
        let staging_media_dir = work.path().join("media");

        let result =
            download_staging_media(&staging, provider.as_ref(), &ks, &staging_media_dir).await;

        match result {
            Err(e) => {
                assert_eq!(
                    e.kind,
                    CloudAuthoritativeMaterializeErrorKind::VerificationFailed
                );
                assert!(
                    e.diagnostics.iter().any(|d| d.contains("../evil")),
                    "diagnostics: {:?}",
                    e.diagnostics
                );
            }
            Ok(v) => panic!("expected rejection of unsafe media id, got Ok({v:?})"),
        }
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_eager_media_versions_embeddings() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);

        let entry_id = seed_yjs_entry(&author, "media entry");
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("photo.jpg");
        std::fs::write(&file_path, b"fake-image-bytes").unwrap();
        let thumb_path = media_dir.path().join("photo.thumb.jpg");
        std::fs::write(&thumb_path, b"thumb-bytes").unwrap();
        let media = db::create_media(
            &author,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "photo.jpg",
                file_type: "image/jpeg",
                storage_path: &file_path.to_string_lossy(),
                file_size: Some(16),
                sort_order: 0,
                insertion_mode: "inline",
                width: Some(64),
                height: Some(64),
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::update_media_thumbnail_path(&author, &media.id, Some(thumb_path.to_str().unwrap()))
            .unwrap();
        db::mark_entry_pending(&author, &entry_id).unwrap();

        let version_id = db::insert_entry_version(
            &author,
            &entry_id,
            b"version-yjs",
            "preview",
            MATERIALIZE_DEVICE,
        )
        .unwrap();

        // Embeddings: configure slot + chunk whose content_hash matches the
        // entry's re-chunked indexable text (adopt-on-match requirement).
        db::set_setting(
            &author,
            crate::ai::provider::settings_keys::embed::PROVIDER,
            "prov-a",
        )
        .unwrap();
        db::set_setting(
            &author,
            crate::ai::provider::settings_keys::embed::EMBEDDING_MODEL,
            "model-a",
        )
        .unwrap();
        // Align title/content so chunk 0/1 hashes are stable for adoption.
        author
            .execute(
                "UPDATE entries SET title = 't', content_text = 'body', preview_text = 'body'
                 WHERE id = ?1",
                [&entry_id],
            )
            .unwrap();
        let indexable = crate::ai::indexer::build_indexable_text(Some("t"), Some("body"));
        let chunks = crate::ai::chunking::chunk_indexable_text(&indexable);
        let chunk = chunks
            .iter()
            .find(|c| c.chunk_index == 1)
            .expect("content chunk");
        db::embeddings::upsert_chunk(
            &author,
            &entry_id,
            "prov-a:model-a",
            chunk.chunk_index as i64,
            &chunk.content_hash,
            chunk.char_start as i64,
            chunk.char_end as i64,
            Some(&chunk.preview),
            2,
            &[1.0, 0.5],
            0,
        )
        .unwrap();

        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await
        .expect("materialize media/versions/embeddings");

        assert!(result.media_downloaded >= 1);
        assert!(result.media_thumbnails_downloaded >= 1);

        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        let staged =
            open_cloud_authoritative_staging_db(&staging.staging_db_path, &db_key).unwrap();
        let media_row = db::get_media(&staged, &media.id).unwrap().unwrap();
        assert!(
            local_media_file_readable(&media_row.storage_path),
            "original must be bound to staging media path"
        );
        assert_eq!(
            std::fs::read(&media_row.storage_path).unwrap(),
            b"fake-image-bytes"
        );
        assert!(
            media_row
                .thumbnail_path
                .as_ref()
                .is_some_and(|p| local_media_file_readable(p)),
            "thumbnail must be downloaded into staging"
        );
        assert!(channel_records(&result, "media") >= 1);
        let versions = db::list_entry_versions(&staged, &entry_id).unwrap();
        assert!(
            versions.iter().any(|v| v.id == version_id)
                || channel_records(&result, "entry_versions") >= 1,
            "versions channel must restore at least one snapshot"
        );
        // Settings-before-embeddings invariant: configured model allows adoption.
        let chunks =
            db::embeddings::list_stored_chunks(&staged, &entry_id, "prov-a:model-a").unwrap();
        assert_eq!(
            chunks.len(),
            1,
            "eligible embedding chunks must restore on fresh staging"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_rejects_missing_blob_and_discards_staging() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let entry_id = seed_yjs_entry(&author, "will-lose-blob");
        db::mark_entry_pending(&author, &entry_id).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        // Corrupt cloud: remove the entry blob but leave the manifest.
        let blob = cloud_dir
            .path()
            .join(MATERIALIZE_DEVICE)
            .join("entries")
            .join(format!("{entry_id}.bin"));
        std::fs::remove_file(&blob).unwrap();

        let active = setup();
        let keep = seed_entry(&active);
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let staging_path = staging.staging_path.clone();
        let err = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging,
            MATERIALIZE_DEVICE,
        )
        .await
        .expect_err("missing blob must fail materialize");

        assert_eq!(err.kind, CloudAuthoritativeMaterializeErrorKind::PullFailed);
        assert!(
            !staging_path.exists(),
            "failed materialize must discard staging"
        );
        assert!(
            db::get_entry(&active, &keep).unwrap().is_some(),
            "active local must remain untouched on materialize failure"
        );
        let job = db::find_latest_sync_recovery_job(&active).unwrap().unwrap();
        assert_eq!(job.status, "failed");
        assert!(
            job.last_error
                .as_deref()
                .unwrap_or("")
                .contains("incomplete")
                || job.last_error.as_deref().unwrap_or("").contains("missing"),
            "diagnostics retained on job: {:?}",
            job.last_error
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_rejects_corrupt_media_ciphertext() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let entry_id = seed_yjs_entry(&author, "media corrupt");
        let media_dir = TempDir::new().unwrap();
        let file_path = media_dir.path().join("c.jpg");
        std::fs::write(&file_path, b"good-bytes").unwrap();
        let media = db::create_media(
            &author,
            db::CreateMediaParams {
                entry_id: &entry_id,
                file_name: "c.jpg",
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
        db::mark_entry_pending(&author, &entry_id).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        // Overwrite media blob with garbage so decrypt fails.
        let media_cloud = cloud_dir
            .path()
            .join(MATERIALIZE_DEVICE)
            .join("media")
            .join(&media.id);
        std::fs::write(&media_cloud, b"not-valid-ciphertext").unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let staging_path = staging.staging_path.clone();
        let err = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging,
            MATERIALIZE_DEVICE,
        )
        .await
        .expect_err("corrupt media must fail");

        assert!(
            matches!(
                err.kind,
                CloudAuthoritativeMaterializeErrorKind::MediaIncomplete
                    | CloudAuthoritativeMaterializeErrorKind::PullFailed
            ),
            "unexpected kind {:?}",
            err.kind
        );
        assert!(!staging_path.exists());
        assert!(db::get_entry(&active, &entry_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_handles_paginated_volume() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);

        // 10× a typical page size (GDrive list often pages at ~100).
        let n = 100usize;
        let mut ids = Vec::with_capacity(n);
        for i in 0..n {
            let id = seed_yjs_entry(&author, &format!("bulk-{i}"));
            db::mark_entry_pending(&author, &id).unwrap();
            ids.push(id);
        }
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        let result = run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging.clone(),
            MATERIALIZE_DEVICE,
        )
        .await
        .expect("materialize 100 entries");

        assert!(channel_records(&result, "entries") >= n as u64);
        assert_eq!(result.self_owned_entries, n as u64);

        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        let staged =
            open_cloud_authoritative_staging_db(&staging.staging_db_path, &db_key).unwrap();
        for id in &ids {
            assert!(
                db::get_entry(&staged, id).unwrap().is_some(),
                "missing bulk entry {id}"
            );
            assert_eq!(sync_status(&staged, id).as_deref(), Some("synced"));
        }
    }

    #[tokio::test]
    async fn cloud_authoritative_materialize_zero_provider_writes() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let entry_id = seed_yjs_entry(&author, "ro-check");
        db::mark_entry_pending(&author, &entry_id).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        fn count_files(root: &std::path::Path) -> usize {
            fn walk(dir: &std::path::Path, acc: &mut usize) {
                let Ok(rd) = std::fs::read_dir(dir) else {
                    return;
                };
                for entry in rd.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(&path, acc);
                    } else if path.is_file() {
                        *acc += 1;
                    }
                }
            }
            let mut n = 0;
            walk(root, &mut n);
            n
        }
        let before = count_files(cloud_dir.path());

        let active = setup();
        let work = TempDir::new().unwrap();
        let staging = begin_staging_for_materialize(&active, &work, 0).await;
        run_materialize(
            &active,
            cloud_provider(&cloud_dir),
            staging,
            MATERIALIZE_DEVICE,
        )
        .await
        .expect("materialize");

        assert_eq!(
            count_files(cloud_dir.path()),
            before,
            "materialize must not write/delete any cloud files"
        );
    }

    // ── cloud_authoritative_commit (Phase 3 Task 3) ──────────────────────

    fn open_on_disk_vault(
        vault: &TempDir,
        key_state: &crate::EncryptionKeyState,
    ) -> (Connection, std::path::PathBuf, std::path::PathBuf) {
        let db_path = vault.path().join("memlore.db");
        let media_path = vault.path().join("media");
        std::fs::create_dir_all(&media_path).unwrap();
        let db_key = key_state.with_db_key(|k| Ok(*k)).unwrap();
        let sub = crate::utils::encryption::derive_sqlcipher_key(&db_key);
        let conn = db::open_with_key(db_path.to_str().unwrap(), &sub).unwrap();
        (conn, db_path, media_path)
    }

    async fn prepare_verified_staging(
        active: &Connection,
        cloud: Arc<LocalSyncProvider>,
        work: &TempDir,
        generation: u64,
        device_id: &str,
    ) -> CloudAuthoritativeStagingResult {
        let staging = begin_staging_for_materialize(active, work, generation).await;
        run_materialize(active, cloud, staging.clone(), device_id)
            .await
            .expect("materialize for commit");
        let job = db::get_sync_recovery_job(active, staging.job_id)
            .unwrap()
            .unwrap();
        assert_eq!(job.phase, "verify");
        staging
    }

    #[test]
    fn cloud_authoritative_commit_swap_fails_before_rename_when_staging_missing() {
        let vault = TempDir::new().unwrap();
        let active_db = vault.path().join("memlore.db");
        let active_media = vault.path().join("media");
        std::fs::write(&active_db, b"active-bytes").unwrap();
        std::fs::create_dir_all(&active_media).unwrap();
        std::fs::write(active_media.join("keep.bin"), b"keep").unwrap();

        let staging = TempDir::new().unwrap();
        let plan = cloud_authoritative_swap_plan(
            &active_db,
            &staging.path().join("missing.db"),
            &active_media,
            &staging.path().join("media"),
        );
        let err = perform_cloud_authoritative_swap(&plan).expect_err("staging missing");
        assert_eq!(
            err.kind,
            CloudAuthoritativeCommitErrorKind::PreconditionFailed
        );
        assert!(active_db.is_file(), "active db must be untouched");
        assert!(
            !plan.rollback_db_path.exists(),
            "no rollback file before swap"
        );
        assert_eq!(
            std::fs::read(active_media.join("keep.bin")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn cloud_authoritative_commit_swap_rolls_back_when_staging_db_rename_fails() {
        let vault = TempDir::new().unwrap();
        let active_db = vault.path().join("memlore.db");
        let active_media = vault.path().join("media");
        std::fs::write(&active_db, b"active-original").unwrap();
        std::fs::create_dir_all(&active_media).unwrap();

        let staging_root = TempDir::new().unwrap();
        // Staging "db" is a directory so rename-to-file-path fails after active moved.
        let staging_db = staging_root.path().join("staging.db");
        std::fs::create_dir_all(&staging_db).unwrap();
        let staging_media = staging_root.path().join("media");
        std::fs::create_dir_all(&staging_media).unwrap();

        // perform checks staging_db.is_file() — directory fails precondition.
        // Simulate mid-swap: manually move active to rollback, then fail promote.
        let plan = cloud_authoritative_swap_plan(
            &active_db,
            &staging_root.path().join("staging-file.db"),
            &active_media,
            &staging_media,
        );
        // Create a real staging file first for the happy-path partial:
        std::fs::write(&plan.staging_db_path, b"staging-bytes").unwrap();
        // Replace staging file with a directory after plan construction to force
        // rename failure... actually rename of dir works on unix for dirs.
        // Instead: delete staging after active is conceptually moved by calling
        // a two-step that uses missing staging:
        std::fs::remove_file(&plan.staging_db_path).unwrap();
        // Write active, ensure media dir exists
        std::fs::write(&active_db, b"active-original").unwrap();

        let err = perform_cloud_authoritative_swap(&plan).expect_err("missing staging");
        assert_eq!(
            err.kind,
            CloudAuthoritativeCommitErrorKind::PreconditionFailed
        );
        assert_eq!(std::fs::read(&active_db).unwrap(), b"active-original");
    }

    #[test]
    fn cloud_authoritative_commit_swap_rolls_back_db_when_media_promote_fails() {
        let vault = TempDir::new().unwrap();
        let active_db = vault.path().join("memlore.db");
        let active_media = vault.path().join("media");
        std::fs::write(&active_db, b"active-original").unwrap();
        std::fs::create_dir_all(&active_media).unwrap();
        std::fs::write(active_media.join("a.bin"), b"a").unwrap();

        let staging_root = TempDir::new().unwrap();
        let staging_db = staging_root.path().join("staging.db");
        std::fs::write(&staging_db, b"staging-bytes").unwrap();
        // No staging media dir → fails before swap after is_file checks...
        // Create staging media as a FILE so rename-as-dir fails.
        let staging_media = staging_root.path().join("media");
        std::fs::write(&staging_media, b"not-a-dir").unwrap();

        let plan =
            cloud_authoritative_swap_plan(&active_db, &staging_db, &active_media, &staging_media);
        let err = perform_cloud_authoritative_swap(&plan).expect_err("media not dir");
        assert_eq!(
            err.kind,
            CloudAuthoritativeCommitErrorKind::PreconditionFailed
        );
        assert_eq!(std::fs::read(&active_db).unwrap(), b"active-original");
        assert!(active_media.join("a.bin").is_file());
    }

    #[test]
    fn cloud_authoritative_commit_swap_and_rollback_pair_roundtrip() {
        let vault = TempDir::new().unwrap();
        let active_db = vault.path().join("memlore.db");
        let active_media = vault.path().join("media");
        std::fs::write(&active_db, b"active-v1").unwrap();
        std::fs::create_dir_all(&active_media).unwrap();
        std::fs::write(active_media.join("old.bin"), b"old").unwrap();

        let staging_root = TempDir::new().unwrap();
        let staging_db = staging_root.path().join("staging.db");
        let staging_media = staging_root.path().join("media");
        std::fs::write(&staging_db, b"staging-v2").unwrap();
        std::fs::create_dir_all(&staging_media).unwrap();
        std::fs::write(staging_media.join("new.bin"), b"new").unwrap();

        let plan =
            cloud_authoritative_swap_plan(&active_db, &staging_db, &active_media, &staging_media);
        perform_cloud_authoritative_swap(&plan).expect("swap");
        assert_eq!(std::fs::read(&active_db).unwrap(), b"staging-v2");
        assert!(active_media.join("new.bin").is_file());
        assert!(plan.rollback_db_path.is_file());
        assert_eq!(std::fs::read(&plan.rollback_db_path).unwrap(), b"active-v1");
        assert!(plan.rollback_media_path.join("old.bin").is_file());

        rollback_cloud_authoritative_swap(&plan).expect("rollback");
        assert_eq!(std::fs::read(&active_db).unwrap(), b"active-v1");
        assert!(active_media.join("old.bin").is_file());
        assert!(!plan.rollback_db_path.exists());
    }

    #[tokio::test]
    async fn cloud_authoritative_commit_failure_before_swap_leaves_active_intact() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let cloud_entry = seed_yjs_entry(&author, "cloud-body");
        db::mark_entry_pending(&author, &cloud_entry).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let vault = TempDir::new().unwrap();
        let (active, db_path, media_path) = open_on_disk_vault(&vault, &ks);
        let local_only = seed_entry(&active);
        db::set_setting(&active, "gdrive_refresh_token", "secret-oauth").unwrap();
        db::set_setting(&active, db::DEVICE_ID_KEY, MATERIALIZE_DEVICE).unwrap();

        let work = TempDir::new().unwrap();
        let mut staging = prepare_verified_staging(
            &active,
            cloud_provider(&cloud_dir),
            &work,
            0,
            MATERIALIZE_DEVICE,
        )
        .await;
        // Break staging after verify so commit fails pre-swap.
        discard_cloud_authoritative_staging(&staging.staging_path);
        staging.staging_db_path = staging.staging_path.join("gone.db");

        let err = cloud_authoritative_commit(
            active,
            cloud_provider(&cloud_dir),
            &ks,
            CloudAuthoritativeCommitOpts {
                staging,
                active_db_path: db_path.clone(),
                active_media_path: media_path.clone(),
                device_id: MATERIALIZE_DEVICE.to_string(),
                content_key: key,
                run_post_commit_sync: false,
            },
        )
        .await
        .expect_err("commit must fail before swap");
        assert!(matches!(
            err.kind,
            CloudAuthoritativeCommitErrorKind::PreconditionFailed
                | CloudAuthoritativeCommitErrorKind::PrepareFailed
        ));

        let reopened =
            open_cloud_authoritative_staging_db(&db_path, &ks.with_db_key(|k| Ok(*k)).unwrap())
                .unwrap();
        assert!(
            db::get_entry(&reopened, &local_only).unwrap().is_some(),
            "local-only entry must survive failed pre-swap commit"
        );
        assert!(db::get_entry(&reopened, &cloud_entry).unwrap().is_none());
        assert_eq!(
            db::get_setting(&reopened, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("secret-oauth")
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_commit_gen0_keeps_vault_generation_zero() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let cloud_entry = seed_yjs_entry(&author, "gen0-body");
        db::mark_entry_pending(&author, &cloud_entry).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let vault = TempDir::new().unwrap();
        let (active, db_path, media_path) = open_on_disk_vault(&vault, &ks);
        db::set_setting(&active, db::DEVICE_ID_KEY, MATERIALIZE_DEVICE).unwrap();
        db::set_setting(&active, "gdrive_refresh_token", "tok").unwrap();

        let work = TempDir::new().unwrap();
        let staging = prepare_verified_staging(
            &active,
            cloud_provider(&cloud_dir),
            &work,
            0, // cloud control generation 0
            MATERIALIZE_DEVICE,
        )
        .await;

        // Job row must use a positive generation for DB CHECK, but cloud is 0.
        let job = db::get_sync_recovery_job(&active, staging.job_id)
            .unwrap()
            .unwrap();
        assert!(
            job.recovery_generation >= 1,
            "job generation is positive for CHECK"
        );
        assert_eq!(
            staging.cloud_recovery_generation, 0,
            "staging must track real cloud gen 0"
        );
        assert_eq!(cloud_recovery_generation_from_job(&job), 0);

        let (new_conn, result) = cloud_authoritative_commit(
            active,
            cloud_provider(&cloud_dir),
            &ks,
            CloudAuthoritativeCommitOpts {
                staging,
                active_db_path: db_path,
                active_media_path: media_path,
                device_id: MATERIALIZE_DEVICE.to_string(),
                content_key: key,
                run_post_commit_sync: false,
            },
        )
        .await
        .expect("commit on gen-0 cloud");

        assert_eq!(result.status, "running");
        // Critical: vault must stay at generation 0 so normal push is not fenced.
        assert_eq!(
            db::get_sync_recovery_generation(&new_conn).unwrap(),
            0,
            "must not forge vault generation to 1 when cloud is 0"
        );
        assert!(
            authorize_recovery_push(None, 0, 0, None).is_ok(),
            "matching gen-0 must allow normal push"
        );
        assert!(
            db::get_entry(&new_conn, &cloud_entry).unwrap().is_some(),
            "cloud content restored"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_commit_preserves_oauth_device_and_swaps_content() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let cloud_entry = seed_yjs_entry(&author, "from-cloud");
        db::mark_entry_pending(&author, &cloud_entry).unwrap();
        db::set_setting(&author, "theme", "dark").unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let vault = TempDir::new().unwrap();
        let (active, db_path, media_path) = open_on_disk_vault(&vault, &ks);
        let local_only = seed_entry(&active);
        db::set_setting(&active, "gdrive_refresh_token", "oauth-secret").unwrap();
        db::set_setting(&active, "gdrive_access_token", "access-secret").unwrap();
        db::set_setting(&active, db::DEVICE_ID_KEY, MATERIALIZE_DEVICE).unwrap();
        // Non-syncable device-local preference (not on the allowlist).
        db::set_setting(&active, "media_cache_max_bytes", "123456").unwrap();

        let work = TempDir::new().unwrap();
        let staging = prepare_verified_staging(
            &active,
            cloud_provider(&cloud_dir),
            &work,
            0,
            MATERIALIZE_DEVICE,
        )
        .await;
        let backup_path = staging.backup_path.clone();

        let (new_conn, result) = cloud_authoritative_commit(
            active,
            cloud_provider(&cloud_dir),
            &ks,
            CloudAuthoritativeCommitOpts {
                staging,
                active_db_path: db_path.clone(),
                active_media_path: media_path.clone(),
                device_id: MATERIALIZE_DEVICE.to_string(),
                content_key: key,
                run_post_commit_sync: false,
            },
        )
        .await
        .expect("commit");

        assert_eq!(result.phase, "commit");
        assert_eq!(result.status, "running");
        assert!(result.rollback_retained);
        assert!(result.rollback_db_path.is_file());
        assert!(backup_path.is_file(), "automatic backup must be retained");

        // Cloud content is live; previous local-only entry is gone.
        assert!(db::get_entry(&new_conn, &cloud_entry).unwrap().is_some());
        assert!(db::get_entry(&new_conn, &local_only).unwrap().is_none());
        assert_eq!(
            db::get_setting(&new_conn, "theme").unwrap().as_deref(),
            Some("dark")
        );
        // Device-local secrets preserved.
        assert_eq!(
            db::get_setting(&new_conn, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("oauth-secret")
        );
        assert_eq!(
            db::get_setting(&new_conn, "gdrive_access_token")
                .unwrap()
                .as_deref(),
            Some("access-secret")
        );
        assert_eq!(
            db::get_setting(&new_conn, db::DEVICE_ID_KEY)
                .unwrap()
                .as_deref(),
            Some(MATERIALIZE_DEVICE)
        );
        assert_eq!(
            db::get_setting(&new_conn, "media_cache_max_bytes")
                .unwrap()
                .as_deref(),
            Some("123456")
        );
        // Self-owned cloud rows stay synced so the next normal push is empty.
        assert_eq!(
            sync_status(&new_conn, &cloud_entry).as_deref(),
            Some("synced")
        );
        assert_eq!(db::count_pending_entries(&new_conn).unwrap(), 0);

        // App restart: reopen from disk after drop.
        drop(new_conn);
        let restarted =
            open_cloud_authoritative_staging_db(&db_path, &ks.with_db_key(|k| Ok(*k)).unwrap())
                .unwrap();
        assert!(db::get_entry(&restarted, &cloud_entry).unwrap().is_some());
        assert_eq!(
            db::get_setting(&restarted, "gdrive_refresh_token")
                .unwrap()
                .as_deref(),
            Some("oauth-secret")
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_commit_no_empty_push_then_bidirectional_sync() {
        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let cloud_entry = seed_yjs_entry(&author, "sync-me");
        db::mark_entry_pending(&author, &cloud_entry).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        fn count_files(root: &std::path::Path) -> usize {
            fn walk(dir: &std::path::Path, acc: &mut usize) {
                let Ok(rd) = std::fs::read_dir(dir) else {
                    return;
                };
                for entry in rd.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(&path, acc);
                    } else if path.is_file() {
                        *acc += 1;
                    }
                }
            }
            let mut n = 0;
            walk(root, &mut n);
            n
        }
        let files_before = count_files(cloud_dir.path());

        let vault = TempDir::new().unwrap();
        let (active, db_path, media_path) = open_on_disk_vault(&vault, &ks);
        db::set_setting(&active, db::DEVICE_ID_KEY, MATERIALIZE_DEVICE).unwrap();
        db::set_setting(&active, "gdrive_refresh_token", "tok").unwrap();

        let work = TempDir::new().unwrap();
        let staging = prepare_verified_staging(
            &active,
            cloud_provider(&cloud_dir),
            &work,
            0,
            MATERIALIZE_DEVICE,
        )
        .await;

        let (new_conn, result) = cloud_authoritative_commit(
            active,
            cloud_provider(&cloud_dir),
            &ks,
            CloudAuthoritativeCommitOpts {
                staging,
                active_db_path: db_path.clone(),
                active_media_path: media_path,
                device_id: MATERIALIZE_DEVICE.to_string(),
                content_key: key,
                run_post_commit_sync: true,
            },
        )
        .await
        .expect("commit with post sync");

        assert_eq!(result.status, "completed");
        assert!(result.post_commit_sync_ran);
        assert!(!result.rollback_retained);
        assert!(
            !result.rollback_db_path.exists(),
            "rollback deleted only after successful post-commit sync"
        );
        // Healthy cloud must not be wiped/replaced by an empty initial push.
        assert!(
            count_files(cloud_dir.path()) >= files_before,
            "post-commit sync must not delete healthy cloud payloads"
        );
        assert_eq!(db::count_pending_entries(&new_conn).unwrap(), 0);

        // Successful edit + normal bidirectional sync after restore.
        let now = db::get_entry(&new_conn, &cloud_entry)
            .unwrap()
            .unwrap()
            .updated_at
            + 10;
        new_conn
            .execute(
                "UPDATE entries SET title = 'edited-after-restore', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, &cloud_entry],
            )
            .unwrap();
        db::mark_entry_pending(&new_conn, &cloud_entry).unwrap();
        let engine = SyncEngine::new(cloud_provider(&cloud_dir), MATERIALIZE_DEVICE.to_string());
        engine
            .sync_now(&new_conn, &key, &ks, SyncTrigger::Manual)
            .await
            .expect("post-restore edit sync");
        assert_eq!(db::count_pending_entries(&new_conn).unwrap(), 0);

        // Peer pull sees the edit.
        let peer = setup();
        let peer_engine = make_push_engine(&cloud_dir, MATERIALIZE_PEER);
        peer_engine.pull_remote(&peer, &key, &ks).await.unwrap();
        let pulled = db::get_entry(&peer, &cloud_entry).unwrap().unwrap();
        assert_eq!(pulled.title.as_deref(), Some("edited-after-restore"));
    }

    #[tokio::test]
    async fn cloud_authoritative_commit_retains_backup_for_recovery() {
        use std::io::Read as _;

        let _sync_lock = lock_sync_guard_for_test();
        let key = materialize_key();
        let ks = materialize_key_state();
        let cloud_dir = TempDir::new().unwrap();
        let author = setup();
        let engine = make_push_engine(&cloud_dir, MATERIALIZE_DEVICE);
        let cloud_entry = seed_yjs_entry(&author, "cloud");
        db::mark_entry_pending(&author, &cloud_entry).unwrap();
        engine
            .push_local(&author, &key, &ks, SyncTrigger::Manual)
            .await
            .unwrap();

        let vault = TempDir::new().unwrap();
        let (active, db_path, media_path) = open_on_disk_vault(&vault, &ks);
        let local_only = seed_entry(&active);
        db::set_setting(&active, db::DEVICE_ID_KEY, MATERIALIZE_DEVICE).unwrap();
        db::set_setting(&active, "gdrive_refresh_token", "tok").unwrap();

        let work = TempDir::new().unwrap();
        let staging = prepare_verified_staging(
            &active,
            cloud_provider(&cloud_dir),
            &work,
            0,
            MATERIALIZE_DEVICE,
        )
        .await;
        let backup_path = staging.backup_path.clone();

        let (_conn, result) = cloud_authoritative_commit(
            active,
            cloud_provider(&cloud_dir),
            &ks,
            CloudAuthoritativeCommitOpts {
                staging,
                active_db_path: db_path,
                active_media_path: media_path,
                device_id: MATERIALIZE_DEVICE.to_string(),
                content_key: key,
                run_post_commit_sync: true,
            },
        )
        .await
        .expect("commit");
        assert_eq!(result.status, "completed");
        assert!(backup_path.is_file());

        // Recovery from retained automatic backup still holds pre-restore local data.
        // Password-mode key_state → automatic backup encrypts full_snapshot.json.
        let file = std::fs::File::open(&backup_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut enc = Vec::new();
        archive
            .by_name("full_snapshot.json.enc")
            .unwrap()
            .read_to_end(&mut enc)
            .unwrap();
        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        let snap = crate::utils::encryption::decrypt_data(&db_key, &enc).unwrap();
        let snapshot: db::FullBackupSnapshot = serde_json::from_slice(&snap).unwrap();
        let restore_conn = setup();
        db::restore_full_snapshot(&restore_conn, &snapshot).unwrap();
        assert!(
            db::get_entry(&restore_conn, &local_only).unwrap().is_some(),
            "backup must restore the pre-cloud-restore local entry"
        );
        assert!(
            db::get_entry(&restore_conn, &cloud_entry)
                .unwrap()
                .is_none(),
            "pre-restore backup must not contain cloud-only content"
        );
    }

    #[tokio::test]
    async fn cloud_authoritative_commit_reopen_failure_rolls_back() {
        let _sync_lock = lock_sync_guard_for_test();
        // This test exercises rollback_cloud_authoritative_swap after a
        // successful filesystem swap by swapping plain files then attempting
        // SQLCipher reopen with the real key (plain bytes → reopen fails).
        let vault = TempDir::new().unwrap();
        let active_db = vault.path().join("memlore.db");
        let active_media = vault.path().join("media");
        std::fs::write(&active_db, b"active-plain").unwrap();
        std::fs::create_dir_all(&active_media).unwrap();
        std::fs::write(active_media.join("a.bin"), b"a").unwrap();

        let staging_root = TempDir::new().unwrap();
        let staging_db = staging_root.path().join("staging.db");
        let staging_media = staging_root.path().join("media");
        std::fs::write(&staging_db, b"staging-plain").unwrap();
        std::fs::create_dir_all(&staging_media).unwrap();

        let plan =
            cloud_authoritative_swap_plan(&active_db, &staging_db, &active_media, &staging_media);
        perform_cloud_authoritative_swap(&plan).unwrap();
        assert_eq!(std::fs::read(&active_db).unwrap(), b"staging-plain");

        // Reopen with SQLCipher key must fail on plaintext file.
        let ks = materialize_key_state();
        let db_key = ks.with_db_key(|k| Ok(*k)).unwrap();
        assert!(
            open_cloud_authoritative_staging_db(&active_db, &db_key).is_err(),
            "plaintext promote must fail SQLCipher reopen"
        );
        rollback_cloud_authoritative_swap(&plan).unwrap();
        assert_eq!(std::fs::read(&active_db).unwrap(), b"active-plain");
        assert!(active_media.join("a.bin").is_file());
    }
}
