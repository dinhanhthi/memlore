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

    /// Helper: a minimal valid `KeyringMetaV2` JSON string.
    fn meta_json() -> &'static str {
        r#"{
            "version": 2,
            "epoch": 1,
            "master_fingerprint": "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            "content_epoch": 0,
            "created_at": 1700000000,
            "updated_at": 1700000001
        }"#
    }

    fn recovery_json() -> &'static str {
        // wrapped_master: exactly 120 hex chars = nonce(24) || ct(64) || tag(32)
        // 0123456789abcdef repeated 7 times = 112 chars + 8 more = 120 total
        r#"{
            "version": 2,
            "wrapped_master": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
            "created_at": 1700000000
        }"#
    }

    fn device_json() -> &'static str {
        r#"{
            "version": 2,
            "device_id": "11111111-2222-3333-4444-555555555555",
            "name": "MacBook Pro",
            "created_at": 1700000000,
            "last_seen_at": 1700000001
        }"#
    }

    #[test]
    fn keyring_meta_v2_serde_roundtrip() {
        let original: KeyringMetaV2 = serde_json::from_str(meta_json()).unwrap();
        assert_eq!(original.version, KEYRING_V2_VERSION);
        assert_eq!(original.epoch, 1);
        assert_eq!(original.content_epoch, 0);
        let serialized = serde_json::to_string(&original).unwrap();
        let roundtripped: KeyringMetaV2 = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped.version, original.version);
        assert_eq!(roundtripped.epoch, original.epoch);
        assert_eq!(roundtripped.master_fingerprint, original.master_fingerprint);
        assert_eq!(roundtripped.content_epoch, original.content_epoch);
        assert_eq!(roundtripped.created_at, original.created_at);
        assert_eq!(roundtripped.updated_at, original.updated_at);
    }

    #[test]
    fn keyring_meta_v2_rejects_unknown_field() {
        let bad = r#"{
            "version": 2,
            "epoch": 1,
            "master_fingerprint": "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            "content_epoch": 0,
            "created_at": 1700000000,
            "updated_at": 1700000001,
            "extra_field": "should_fail"
        }"#;
        let result = serde_json::from_str::<KeyringMetaV2>(bad);
        assert!(
            result.is_err(),
            "deny_unknown_fields must reject extra_field"
        );
    }

    #[test]
    fn recovery_slot_v2_serde_roundtrip() {
        let original: RecoverySlotV2 = serde_json::from_str(recovery_json()).unwrap();
        assert_eq!(original.version, KEYRING_V2_VERSION);
        let serialized = serde_json::to_string(&original).unwrap();
        let roundtripped: RecoverySlotV2 = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped.version, original.version);
        assert_eq!(roundtripped.wrapped_master, original.wrapped_master);
        assert_eq!(roundtripped.created_at, original.created_at);
    }

    #[test]
    fn recovery_slot_v2_rejects_unknown_field() {
        let bad = r#"{
            "version": 2,
            "wrapped_master": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            "created_at": 1700000000,
            "bogus": "nope"
        }"#;
        let result = serde_json::from_str::<RecoverySlotV2>(bad);
        assert!(result.is_err(), "deny_unknown_fields must reject bogus");
    }

    #[test]
    fn device_slot_v2_serde_roundtrip() {
        let original: DeviceSlotV2 = serde_json::from_str(device_json()).unwrap();
        assert_eq!(original.version, KEYRING_V2_VERSION);
        assert_eq!(original.name, "MacBook Pro");
        let serialized = serde_json::to_string(&original).unwrap();
        let roundtripped: DeviceSlotV2 = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped.version, original.version);
        assert_eq!(roundtripped.device_id, original.device_id);
        assert_eq!(roundtripped.name, original.name);
        assert_eq!(roundtripped.created_at, original.created_at);
        assert_eq!(roundtripped.last_seen_at, original.last_seen_at);
    }

    /// Requirement 4 (cloud de-grind): the serialized device slot must never
    /// carry key material. Asserts on the raw JSON bytes, not struct fields —
    /// a struct-field assertion is meaningless once the fields don't exist.
    #[test]
    fn device_slot_v2_serializes_with_no_key_material() {
        let slot = good_device();
        let json = serde_json::to_string(&slot).unwrap();
        assert!(
            !json.contains("wrapped_master"),
            "must not contain wrapped_master: {json}"
        );
        assert!(
            !json.contains("kek_salt"),
            "must not contain kek_salt: {json}"
        );
    }

    #[test]
    fn device_slot_v2_rejects_unknown_field() {
        let bad = r#"{
            "version": 2,
            "device_id": "11111111-2222-3333-4444-555555555555",
            "name": "MacBook Pro",
            "created_at": 1700000000,
            "last_seen_at": 1700000001,
            "surprise": "field"
        }"#;
        let result = serde_json::from_str::<DeviceSlotV2>(bad);
        assert!(result.is_err(), "deny_unknown_fields must reject surprise");
    }

    // ── validate() tests ─────────────────────────────────────────────────────

    fn good_meta() -> KeyringMetaV2 {
        serde_json::from_str(meta_json()).unwrap()
    }

    fn good_recovery() -> RecoverySlotV2 {
        serde_json::from_str(recovery_json()).unwrap()
    }

    fn good_device() -> DeviceSlotV2 {
        serde_json::from_str(device_json()).unwrap()
    }

    // — KeyringMetaV2::validate() —

    #[test]
    fn meta_validate_accepts_good_fixture() {
        assert!(good_meta().validate().is_ok());
    }

    #[test]
    fn meta_validate_rejects_wrong_version() {
        let mut m = good_meta();
        m.version = 99;
        assert!(m.validate().is_err());
    }

    #[test]
    fn meta_validate_rejects_wrong_hex_length() {
        let mut m = good_meta();
        m.master_fingerprint = "abcd".to_string(); // too short
        assert!(m.validate().is_err());
    }

    #[test]
    fn meta_validate_rejects_non_hex_chars() {
        let mut m = good_meta();
        // 64 chars but with non-hex character 'z'
        m.master_fingerprint = "z".repeat(64);
        assert!(m.validate().is_err());
    }

    #[test]
    fn meta_validate_rejects_negative_created_at() {
        let mut m = good_meta();
        m.created_at = -1;
        assert!(m.validate().is_err());
    }

    #[test]
    fn meta_validate_rejects_negative_updated_at() {
        let mut m = good_meta();
        m.updated_at = -1;
        assert!(m.validate().is_err());
    }

    #[test]
    fn meta_validate_rejects_updated_at_before_created_at() {
        let mut m = good_meta();
        m.created_at = 1_700_000_100;
        m.updated_at = 1_700_000_000; // older than created_at
        assert!(m.validate().is_err());
    }

    // — RecoverySlotV2::validate() —

    #[test]
    fn recovery_validate_accepts_good_fixture() {
        assert!(good_recovery().validate().is_ok());
    }

    #[test]
    fn recovery_validate_rejects_wrong_version() {
        let mut r = good_recovery();
        r.version = 1;
        assert!(r.validate().is_err());
    }

    #[test]
    fn recovery_validate_rejects_wrong_hex_length() {
        let mut r = good_recovery();
        r.wrapped_master = "aa".repeat(30); // 60 chars, not 120
        assert!(r.validate().is_err());
    }

    #[test]
    fn recovery_validate_rejects_non_hex_chars() {
        let mut r = good_recovery();
        r.wrapped_master = "g".repeat(120);
        assert!(r.validate().is_err());
    }

    #[test]
    fn recovery_validate_rejects_negative_created_at() {
        let mut r = good_recovery();
        r.created_at = -1;
        assert!(r.validate().is_err());
    }

    // — DeviceSlotV2::validate() —

    #[test]
    fn device_validate_accepts_good_fixture() {
        assert!(good_device().validate().is_ok());
    }

    #[test]
    fn device_validate_rejects_wrong_version() {
        let mut d = good_device();
        d.version = 3;
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_empty_name() {
        let mut d = good_device();
        d.name = String::new();
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_name_too_long() {
        let mut d = good_device();
        d.name = "a".repeat(129);
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_negative_created_at() {
        let mut d = good_device();
        d.created_at = -1;
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_negative_last_seen_at() {
        let mut d = good_device();
        d.last_seen_at = -5;
        assert!(d.validate().is_err());
    }

    // — validate_device_id helper —

    #[test]
    fn device_validate_rejects_device_id_too_short() {
        let mut d = good_device();
        d.device_id = "abc".to_string(); // only 3 chars
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_traversal_payload() {
        let mut d = good_device();
        d.device_id = "../foo".to_string();
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_device_id_starting_with_dash() {
        let mut d = good_device();
        d.device_id = "-1234567".to_string();
        assert!(d.validate().is_err());
    }

    #[test]
    fn device_validate_rejects_device_id_ending_with_dash() {
        let mut d = good_device();
        d.device_id = "1234567-".to_string();
        assert!(d.validate().is_err());
    }

    // ── T4 — KeyringMetaV2 content_epoch roundtrip ────────────────────────────

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
        assert_eq!(meta.epoch, 5);
        assert_eq!(meta.content_epoch, 3);
        assert!(meta.validate().is_ok());

        let serialized = serde_json::to_string(&meta).unwrap();
        let roundtripped: KeyringMetaV2 = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped.content_epoch, 3);
        assert_eq!(roundtripped.epoch, 5);
    }

    // ── T5 — ContentListV2 tests ──────────────────────────────────────────────

    fn good_content_entry(epoch: u32) -> ContentEntryV2 {
        ContentEntryV2 {
            epoch,
            wrapped_content: "ab".repeat(60),     // 120 hex chars
            content_fingerprint: "cd".repeat(32), // 64 hex chars
        }
    }

    fn good_content_list() -> ContentListV2 {
        ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: 1,
            entries: vec![good_content_entry(1)],
            created_at: 1_700_000_000,
        }
    }

    #[test]
    fn content_list_v2_serde_roundtrip() {
        let original = good_content_list();
        let serialized = serde_json::to_string(&original).unwrap();
        let roundtripped: ContentListV2 = serde_json::from_str(&serialized).unwrap();
        assert_eq!(roundtripped.version, original.version);
        assert_eq!(roundtripped.latest_epoch, original.latest_epoch);
        assert_eq!(roundtripped.entries.len(), original.entries.len());
        assert_eq!(roundtripped.entries[0].epoch, 1);
        assert_eq!(
            roundtripped.entries[0].wrapped_content,
            original.entries[0].wrapped_content
        );
        assert_eq!(
            roundtripped.entries[0].content_fingerprint,
            original.entries[0].content_fingerprint
        );
        assert_eq!(roundtripped.created_at, original.created_at);
        assert!(roundtripped.validate().is_ok());
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
        let result = serde_json::from_str::<ContentListV2>(bad);
        assert!(
            result.is_err(),
            "deny_unknown_fields must reject unknown field"
        );
    }

    #[test]
    fn content_list_validate_rejects_bad_fingerprint() {
        let mut list = good_content_list();
        // Too short fingerprint.
        list.entries[0].content_fingerprint = "abcd".to_string();
        assert!(
            list.validate().is_err(),
            "short fingerprint must be rejected"
        );

        // Non-hex fingerprint.
        let mut list2 = good_content_list();
        list2.entries[0].content_fingerprint = "z".repeat(64);
        assert!(
            list2.validate().is_err(),
            "non-hex fingerprint must be rejected"
        );

        // Also test wrapped_content validation.
        let mut list3 = good_content_list();
        list3.entries[0].wrapped_content = "ab".repeat(30); // 60 hex — too short
        assert!(
            list3.validate().is_err(),
            "short wrapped_content must be rejected"
        );
    }

    #[test]
    fn content_list_validate_rejects_nonmonotonic_epochs() {
        let mut list = ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: 2,
            entries: vec![
                good_content_entry(2),
                good_content_entry(1), // epoch 1 after epoch 2 — non-monotonic
            ],
            created_at: 1_700_000_000,
        };
        // latest_epoch matches last entry (1), but we'll also test with a fixed
        // latest_epoch to ensure monotonic check fires first.
        list.latest_epoch = 1;
        assert!(
            list.validate().is_err(),
            "non-monotonic epochs must be rejected"
        );
    }

    #[test]
    fn content_list_validate_accepts_empty_list() {
        let list = ContentListV2 {
            version: KEYRING_V2_VERSION,
            latest_epoch: 0,
            entries: vec![],
            created_at: 1_700_000_000,
        };
        assert!(list.validate().is_ok(), "empty content list must be valid");
    }

    #[test]
    fn content_list_validate_rejects_latest_epoch_mismatch() {
        let mut list = good_content_list();
        list.latest_epoch = 99; // doesn't match last entry's epoch (1)
        assert!(
            list.validate().is_err(),
            "latest_epoch mismatch must be rejected"
        );
    }
}
