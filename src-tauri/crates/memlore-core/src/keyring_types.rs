//! V2 keyring cloud-JSON structs.
//!
//! All structs use `#[serde(deny_unknown_fields)]` because they originate from
//! cloud storage that is outside our trust boundary. An unknown field indicates
//! either a future schema version or tampered data — either way we want to fail
//! loudly rather than silently ignore it.
//!
//! **Breaking-change note (dev mode):** `deny_unknown_fields` means any future
//! field addition is a wire-breaking change for existing devices. Acceptable
//! pre-release; revisit before v1.0.

use serde::{Deserialize, Serialize};

/// V2 keyring version tag. Every cloud struct in this module carries a `version`
/// field that must equal this value on read.
pub const KEYRING_V2_VERSION: u32 = 2;
pub const RECOVERY_MARKER_VERSION: u32 = 1;

// ─── Validation helpers ───────────────────────────────────────────────────────

/// Check that `s` is exactly `expected_len` hex characters (0-9, a-f, A-F).
fn validate_hex_len(s: &str, expected_len: usize, field: &str) -> Result<(), String> {
    if s.len() != expected_len {
        return Err(format!(
            "{field}: expected {expected_len} hex chars, got {}",
            s.len()
        ));
    }
    if !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{field}: must be hex"));
    }
    Ok(())
}

/// Check that `device_id` is a path-safe segment (UUID-like).
/// Allows lowercase hex + hyphens, length 8-64. Strict enough to refuse
/// path-traversal payloads, lenient enough to accept any UUID variant.
fn validate_device_id(s: &str) -> Result<(), String> {
    if s.len() < 8 || s.len() > 64 {
        return Err(format!(
            "device_id: length out of range (8-64), got {}",
            s.len()
        ));
    }
    if !s.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("device_id: only hex chars and '-' allowed".into());
    }
    if s.starts_with('-') || s.ends_with('-') {
        return Err("device_id: must not start/end with '-'".into());
    }
    Ok(())
}

/// Root keyring metadata file (`.meta/keyring/_meta.json`).
///
/// Acts as the single point of contention during key rotation: only this file
/// changes when a device slot is added or removed, keeping per-device files
/// conflict-free.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyringMetaV2 {
    /// Must equal [`KEYRING_V2_VERSION`].
    pub version: u32,
    /// Monotonic counter. Bumped on every rotation so each device can detect
    /// when it has fallen behind (epoch mismatch → force re-pair).
    pub epoch: u64,
    /// 64 hex chars: HMAC-SHA256 of the master key — used for fingerprint
    /// matching across devices without revealing the key itself.
    pub master_fingerprint: String,
    /// Content-key epoch. Bumped on every content-key rotation (append to DEK
    /// list + new master_key). Starts at 0 before any content key is assigned.
    pub content_epoch: u32,
    /// Monotonic authoritative-recovery generation. Zero means no recovery
    /// generation has been committed yet.
    #[serde(default)]
    pub recovery_generation: u64,
    /// Unix seconds when this keyring was first created.
    pub created_at: i64,
    /// Unix seconds when this keyring was last updated.
    pub updated_at: i64,
}

/// Shared recovery fence (`.meta/_recovery_marker.json`). It contains only
/// coordination metadata and never user journal content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RecoveryMarker {
    pub version: u32,
    pub job_id: i64,
    pub owner_device_id: String,
    pub operation: String,
    pub recovery_generation: u64,
    /// Random per-acquisition token. It distinguishes a resumed exact lease
    /// from a later recovery that happens to reuse the same local job id.
    pub nonce: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl RecoveryMarker {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != RECOVERY_MARKER_VERSION {
            return Err(format!(
                "unsupported recovery marker version: {}",
                self.version
            ));
        }
        if self.job_id <= 0 {
            return Err("job_id must be positive".into());
        }
        validate_device_id(&self.owner_device_id)?;
        if !matches!(
            self.operation.as_str(),
            "local_to_cloud" | "cloud_to_local" | "cloud_cleanup"
        ) {
            return Err(
                "operation must be local_to_cloud, cloud_to_local, or cloud_cleanup".into(),
            );
        }
        if self.recovery_generation == 0 {
            return Err("recovery_generation must be positive".into());
        }
        if self.nonce.len() < 16 || !self.nonce.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err("nonce must contain at least 16 hex characters".into());
        }
        if self.created_at < 0 || self.updated_at < self.created_at {
            return Err("timestamps must be non-negative and monotonic".into());
        }
        Ok(())
    }
}

impl KeyringMetaV2 {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != KEYRING_V2_VERSION {
            return Err(format!(
                "unsupported keyring meta version: {}",
                self.version
            ));
        }
        validate_hex_len(&self.master_fingerprint, 64, "master_fingerprint")?;
        if self.created_at < 0 || self.updated_at < 0 {
            return Err("created_at / updated_at must be non-negative".into());
        }
        if self.updated_at < self.created_at {
            return Err("updated_at must be >= created_at".into());
        }
        Ok(())
    }
}

/// Recovery slot (`.meta/keyring/_recovery.json`).
///
/// Contains the master key wrapped with the recovery key derived from the
/// 24-word BIP39 mnemonic. Allows the user to regain access without any
/// device password if all trusted devices are lost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverySlotV2 {
    /// Must equal [`KEYRING_V2_VERSION`].
    pub version: u32,
    /// 120 hex chars: nonce(12) || ct(32) || tag(16) — AES-GCM(recovery_key, master_key).
    pub wrapped_master: String,
    /// Unix seconds when the recovery slot was created.
    pub created_at: i64,
}

impl RecoverySlotV2 {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != KEYRING_V2_VERSION {
            return Err(format!(
                "unsupported recovery slot version: {}",
                self.version
            ));
        }
        validate_hex_len(&self.wrapped_master, 120, "wrapped_master")?;
        if self.created_at < 0 {
            return Err("created_at must be non-negative".into());
        }
        Ok(())
    }
}

/// Per-device slot (`.meta/keyring/devices/{device_id}.json`).
///
/// Pure registry metadata — no key material. The master is reachable on the
/// cloud only via `RecoverySlotV2` (see design §4 "Nothing grindable on the
/// cloud"). This slot exists so Settings → Devices can list peers by name and
/// last-seen time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSlotV2 {
    /// Must equal [`KEYRING_V2_VERSION`].
    pub version: u32,
    /// UUID v4 that identifies this device uniquely.
    pub device_id: String,
    /// Human-readable device name (e.g. `"MacBook Pro"`).
    pub name: String,
    /// Unix seconds when this slot was created.
    pub created_at: i64,
    /// Unix seconds when this device last refreshed its slot.
    pub last_seen_at: i64,
}

impl DeviceSlotV2 {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != KEYRING_V2_VERSION {
            return Err(format!("unsupported device slot version: {}", self.version));
        }
        validate_device_id(&self.device_id)?;
        if self.name.is_empty() || self.name.len() > 128 {
            return Err("device name must be 1-128 chars".into());
        }
        if self.created_at < 0 || self.last_seen_at < 0 {
            return Err("created_at / last_seen_at must be non-negative".into());
        }
        Ok(())
    }
}

// ─── Content-key list (Phase 2) ───────────────────────────────────────────────

/// One entry in the content-key list: the epoch number and the content key
/// wrapped under the master key.
///
/// `.meta/keyring/_content.json` → `entries[*]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentEntryV2 {
    /// Content-key epoch (monotonic, starts at 1).
    pub epoch: u32,
    /// 120 hex chars: nonce(12) || ct(32) || tag(16) —
    /// `AES-GCM(master_key, content_key)`.  No KDF header because master_key
    /// is already uniformly random (same rationale as the recovery slot).
    pub wrapped_content: String,
    /// 64 hex chars: `key_fingerprint(derive_sync_key(content_key))` — the HMAC-SHA256
    /// of the **sync sub-key** derived from the content key, not the raw content key
    /// itself. Matches the fingerprint formula used by `onboard_complete_inner`,
    /// `confirm_first_time_setup`, and `run_cloud_content_migration` for cross-device
    /// validation.
    pub content_fingerprint: String,
}

/// Content-key list cloud file (`.meta/keyring/_content.json`).
///
/// Append-only list of every content-key epoch. Written by the owning device
/// after onboarding / rotation; read by other devices after re-pair to build
/// the full key history needed to decrypt old envelopes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentListV2 {
    /// Format version; must equal [`KEYRING_V2_VERSION`] (2).
    pub version: u32,
    /// The highest epoch present in `entries`; convenient cache to avoid
    /// scanning the list on every read.
    pub latest_epoch: u32,
    /// All content-key epochs in ascending order.
    pub entries: Vec<ContentEntryV2>,
    /// Unix seconds when this file was first created.
    pub created_at: i64,
}

impl ContentListV2 {
    /// Validate the content list.
    ///
    /// Checks:
    /// - `version` must equal [`KEYRING_V2_VERSION`].
    /// - `latest_epoch` must equal the epoch of the last entry (or 0 if empty).
    /// - Entry `wrapped_content` must be exactly 120 hex chars.
    /// - Entry `content_fingerprint` must be exactly 64 hex chars.
    /// - Entry epochs must be strictly monotonically increasing.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != KEYRING_V2_VERSION {
            return Err(format!(
                "unsupported content list version: {}",
                self.version
            ));
        }
        if self.created_at < 0 {
            return Err("created_at must be non-negative".into());
        }

        let mut prev_epoch: Option<u32> = None;
        for (i, entry) in self.entries.iter().enumerate() {
            validate_hex_len(
                &entry.wrapped_content,
                120,
                &format!("entries[{i}].wrapped_content"),
            )?;
            validate_hex_len(
                &entry.content_fingerprint,
                64,
                &format!("entries[{i}].content_fingerprint"),
            )?;
            if let Some(prev) = prev_epoch {
                if entry.epoch <= prev {
                    return Err(format!(
                        "entries[{i}].epoch ({}) must be greater than previous epoch ({})",
                        entry.epoch, prev
                    ));
                }
            }
            prev_epoch = Some(entry.epoch);
        }

        // latest_epoch must match the last entry's epoch (or 0 if empty).
        let expected_latest = self.entries.last().map(|e| e.epoch).unwrap_or(0);
        if self.latest_epoch != expected_latest {
            return Err(format!(
                "latest_epoch ({}) does not match last entry's epoch ({})",
                self.latest_epoch, expected_latest
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors copied from the desktop `sync/keyring_v2/types.rs` tests.

    #[test]
    fn meta_v2_with_content_epoch_roundtrip() {
        let json = r#"{
            "version": 2,
            "epoch": 5,
            "master_fingerprint": "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            "content_epoch": 3,
            "created_at": 1700000000,
            "updated_at": 1700000010
        }"#;
        let meta: KeyringMetaV2 = serde_json::from_str(json).unwrap();
        assert!(meta.validate().is_ok());
        let back: KeyringMetaV2 =
            serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        assert_eq!((back.epoch, back.content_epoch), (5, 3));
    }

    #[test]
    fn content_list_rejects_unknown_field() {
        let bad = r#"{
            "version": 2,
            "latest_epoch": 0,
            "entries": [],
            "created_at": 1700000000,
            "surprise": "value"
        }"#;
        assert!(serde_json::from_str::<ContentListV2>(bad).is_err());
    }

    #[test]
    fn content_list_serde_roundtrip_validates() {
        let list = ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: 1,
            entries: vec![ContentEntryV2 {
                epoch: 1,
                wrapped_content: "ab".repeat(60),
                content_fingerprint: "cd".repeat(32),
            }],
            created_at: 1_700_000_000,
        };
        let back: ContentListV2 =
            serde_json::from_str(&serde_json::to_string(&list).unwrap()).unwrap();
        assert!(back.validate().is_ok());
        assert_eq!(
            back.entries[0].wrapped_content,
            list.entries[0].wrapped_content
        );
    }
}
