//! V2 keyring cloud-JSON structs. The definitions live in `memlore-core` (shared
//! with the web app); this shim keeps every desktop path stable.

pub use memlore_core::keyring_types::*;

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
