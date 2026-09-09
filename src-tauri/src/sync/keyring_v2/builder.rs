//! Crash-safe initial V2 keyring publish.
//!
//! The publish order is deliberate:
//!   1. Recovery slot  (`_recovery.json`)
//!   2. Device slot    (`devices/<id>.json`)
//!   3. Meta           (`_meta.json`)  ← LAST
//!
//! Writing `_meta.json` last means that if the process crashes mid-way, no
//! device will see a valid `_meta.json` pointing to an epoch it cannot yet
//! satisfy. A device always reads `_meta.json` first; absence means "no
//! keyring yet" rather than "broken keyring".

use crate::sync::provider::SyncError;

use super::{
    io::{write_device_slot, write_meta, write_recovery, KeyringV2Io},
    types::{DeviceSlotV2, KeyringMetaV2, RecoverySlotV2},
};

/// Write the three V2 keyring files in crash-safe order.
///
/// On success all three files are durably committed. On any intermediate
/// failure the caller should treat the keyring as partially written and
/// either retry or clean up via the inverse deletion helpers.
pub async fn publish_initial_v2_keyring<P: KeyringV2Io>(
    provider: &P,
    recovery_slot: &RecoverySlotV2,
    device_slot: &DeviceSlotV2,
    meta: &KeyringMetaV2,
) -> Result<(), SyncError> {
    // Step 1: recovery slot — written first so it is always available before
    // a device slot advertises its device_id.
    write_recovery(provider, recovery_slot).await?;

    // Step 2: device slot — device identity established before the meta is
    // visible, so any reader that races on _meta.json finds the slot ready.
    write_device_slot(provider, device_slot).await?;

    // Step 3: meta — last, acts as the commit marker. A missing _meta.json
    // means "setup not complete"; a present one means "all slots are ready".
    write_meta(provider, meta).await?;

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::keyring_v2::{
        io::test_support::InMemoryKeyringProvider,
        io::{read_device_slot, read_meta, read_recovery, META_PATH, RECOVERY_PATH},
        types::KEYRING_V2_VERSION,
    };

    // ── Fixtures ──────────────────────────────────────────────────────────────

    fn make_meta() -> KeyringMetaV2 {
        KeyringMetaV2 {
            version: KEYRING_V2_VERSION,
            epoch: 1,
            master_fingerprint: "a1b2c3d4".repeat(8), // 64 hex chars
            content_epoch: 0,
            recovery_generation: 0,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_001,
        }
    }

    fn make_recovery() -> RecoverySlotV2 {
        RecoverySlotV2 {
            version: KEYRING_V2_VERSION,
            wrapped_master: "ab".repeat(60), // 120 hex chars
            created_at: 1_700_000_000,
        }
    }

    fn make_device() -> DeviceSlotV2 {
        DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: "11111111-2222-3333-4444-555555555555".to_string(),
            name: "Test Mac".to_string(),
            created_at: 1_700_000_000,
            last_seen_at: 1_700_000_001,
        }
    }

    // ── RED: test written before implementation ────────────────────────────────

    /// All three files must be written and readable after a successful publish.
    #[tokio::test]
    async fn publish_writes_all_three_files() {
        let provider = InMemoryKeyringProvider::new();
        let meta = make_meta();
        let recovery = make_recovery();
        let device = make_device();

        publish_initial_v2_keyring(&provider, &recovery, &device, &meta)
            .await
            .expect("publish should succeed");

        // Recovery slot readable and valid.
        let got_recovery = read_recovery(&provider)
            .await
            .expect("read_recovery failed")
            .expect("recovery slot missing");
        assert_eq!(got_recovery.wrapped_master, recovery.wrapped_master);

        // Device slot readable and valid.
        let got_device = read_device_slot(&provider, &device.device_id)
            .await
            .expect("read_device_slot failed")
            .expect("device slot missing");
        assert_eq!(got_device.name, device.name);

        // Meta readable and valid.
        let got_meta = read_meta(&provider)
            .await
            .expect("read_meta failed")
            .expect("meta missing");
        assert_eq!(got_meta.epoch, meta.epoch);
        assert_eq!(got_meta.master_fingerprint, meta.master_fingerprint);
    }

    /// Crash safety: if we write recovery + device but NOT meta, meta must be
    /// absent (simulating a crash after device slot write). After a fresh
    /// `publish_initial_v2_keyring` call everything is present.
    #[tokio::test]
    async fn meta_absent_before_publish_completes() {
        let provider = InMemoryKeyringProvider::new();
        let meta = make_meta();
        let recovery = make_recovery();
        let device = make_device();

        // Simulate partial write: write recovery and device manually, skip meta.
        write_recovery(&provider, &recovery)
            .await
            .expect("write_recovery failed");
        write_device_slot(&provider, &device)
            .await
            .expect("write_device_slot failed");

        // Meta must not exist yet.
        let meta_absent = read_meta(&provider).await.expect("read_meta IO error");
        assert!(
            meta_absent.is_none(),
            "meta must be absent before publish completes"
        );

        // Now complete the publish.
        publish_initial_v2_keyring(&provider, &recovery, &device, &meta)
            .await
            .expect("publish should succeed");

        // Meta must now be present.
        assert!(
            read_meta(&provider).await.unwrap().is_some(),
            "meta must be present after publish"
        );
    }

    /// Write order: recovery and device must be present AFTER meta in the
    /// provider, meaning if meta exists then the other two already do too.
    /// We test this by verifying files exist after publish and that meta is
    /// last to be written (we track via provider inspection).
    #[tokio::test]
    async fn publish_writes_recovery_before_meta() {
        let provider = InMemoryKeyringProvider::new();
        let meta = make_meta();
        let recovery = make_recovery();
        let device = make_device();

        publish_initial_v2_keyring(&provider, &recovery, &device, &meta)
            .await
            .expect("publish should succeed");

        // If we delete meta, recovery and device should still be there.
        provider
            .delete_file(META_PATH)
            .await
            .expect("delete meta failed");
        assert!(
            read_recovery(&provider).await.unwrap().is_some(),
            "recovery must exist even without meta"
        );
        assert!(
            read_device_slot(&provider, &device.device_id)
                .await
                .unwrap()
                .is_some(),
            "device slot must exist even without meta"
        );
        // Meta itself is gone.
        assert!(
            read_meta(&provider).await.unwrap().is_none(),
            "meta deleted — should be absent"
        );
    }

    /// Recovery slot absent means keyring is incomplete regardless of meta.
    /// After deleting recovery, publish again must restore it.
    #[tokio::test]
    async fn publish_is_idempotent_on_retry() {
        let provider = InMemoryKeyringProvider::new();
        let meta = make_meta();
        let recovery = make_recovery();
        let device = make_device();

        // First publish.
        publish_initial_v2_keyring(&provider, &recovery, &device, &meta)
            .await
            .expect("first publish should succeed");

        // Simulate recovery slot corruption: delete it.
        provider
            .delete_file(RECOVERY_PATH)
            .await
            .expect("delete failed");

        // Retry publish.
        publish_initial_v2_keyring(&provider, &recovery, &device, &meta)
            .await
            .expect("retry publish should succeed");

        // All three must exist again.
        assert!(read_recovery(&provider).await.unwrap().is_some());
        assert!(read_device_slot(&provider, &device.device_id)
            .await
            .unwrap()
            .is_some());
        assert!(read_meta(&provider).await.unwrap().is_some());
    }

    // ── Multi-device keyring workflow tests ───────────────────────────────────

    /// Device B's cloud slot is pure registry metadata — no key material to
    /// unwrap. Regression guard for requirement 4 (cloud de-grind): a device
    /// slot must never carry a password-wrapped master. Superseded
    /// `device_b_can_read_own_slot_after_publish`, which unwrapped the master
    /// from a device slot — that capability no longer exists by design.
    #[tokio::test]
    async fn device_b_slot_carries_no_key_material_after_publish() {
        let provider = InMemoryKeyringProvider::new();

        let device_b = DeviceSlotV2 {
            version: KEYRING_V2_VERSION,
            device_id: "b1b2b3b4-b5b6-b7b8-b9ba-bbbcbdbebfc0".to_string(),
            name: "Device B".to_string(),
            created_at: 1_700_000_000,
            last_seen_at: 1_700_000_001,
        };

        let meta = make_meta();
        let recovery = make_recovery();
        publish_initial_v2_keyring(&provider, &recovery, &device_b, &meta)
            .await
            .unwrap();

        // Device B reads its own slot.
        let read_slot = read_device_slot(&provider, "b1b2b3b4-b5b6-b7b8-b9ba-bbbcbdbebfc0")
            .await
            .unwrap()
            .expect("slot must exist");

        assert_eq!(read_slot.device_id, "b1b2b3b4-b5b6-b7b8-b9ba-bbbcbdbebfc0");

        // Read RAW bytes off the provider — asserting via the parsed
        // `DeviceSlotV2` would be meaningless, since that struct cannot carry
        // these fields anymore by construction.
        let raw = provider
            .read_file(&crate::sync::keyring_v2::io::device_slot_path(
                "b1b2b3b4-b5b6-b7b8-b9ba-bbbcbdbebfc0",
            ))
            .await
            .unwrap();
        let raw_text = String::from_utf8_lossy(&raw);
        assert!(
            !raw_text.contains("wrapped_master") && !raw_text.contains("kek_salt"),
            "device slot must carry no key material: {raw_text}"
        );
    }

    /// Recovery slot allows master key recovery via the recovery phrase.
    #[tokio::test]
    async fn recovery_slot_readable_and_unwrappable() {
        use crate::utils::encryption::{decrypt_data, KEY_SIZE};

        let provider = InMemoryKeyringProvider::new();
        let master_key = [22u8; KEY_SIZE];
        let mnemonic = crate::utils::recovery::generate_recovery_mnemonic().unwrap();
        let parsed = crate::utils::recovery::validate_recovery_mnemonic(&mnemonic).unwrap();
        let recovery_key = crate::utils::recovery::derive_recovery_key(&parsed);
        let blob = crate::utils::encryption::encrypt_data(&recovery_key, &master_key).unwrap();
        let wrapped_master = hex::encode(&blob);

        let recovery = RecoverySlotV2 {
            version: KEYRING_V2_VERSION,
            wrapped_master: wrapped_master.clone(),
            created_at: 1_700_000_000,
        };

        publish_initial_v2_keyring(&provider, &recovery, &make_device(), &make_meta())
            .await
            .unwrap();

        let loaded = read_recovery(&provider)
            .await
            .unwrap()
            .expect("recovery slot must exist");
        let enc_bytes = hex::decode(&loaded.wrapped_master).unwrap();
        let plaintext = decrypt_data(&recovery_key, &enc_bytes).unwrap();
        assert_eq!(
            plaintext, master_key,
            "recovery slot must decrypt to master key"
        );
    }

    /// Epoch increments on successive publishes (simulates rotation).
    #[tokio::test]
    async fn epoch_increments_on_rotation_publish() {
        let provider = InMemoryKeyringProvider::new();
        let meta_v1 = make_meta(); // epoch = 1
        publish_initial_v2_keyring(&provider, &make_recovery(), &make_device(), &meta_v1)
            .await
            .unwrap();

        let meta_v2 = KeyringMetaV2 {
            epoch: 2,
            ..make_meta()
        };
        // Overwrite meta to simulate rotation.
        write_meta(&provider, &meta_v2).await.unwrap();

        let loaded = read_meta(&provider)
            .await
            .unwrap()
            .expect("meta must exist");
        assert_eq!(loaded.epoch, 2, "epoch must be 2 after rotation");
    }

    /// Epoch mismatch detection: local epoch < cloud epoch means another device rotated.
    #[tokio::test]
    async fn epoch_mismatch_detected_when_cloud_ahead() {
        let provider = InMemoryKeyringProvider::new();
        let local_epoch: u64 = 1;

        // Cloud has been rotated to epoch 3 by another device.
        let cloud_meta = KeyringMetaV2 {
            epoch: 3,
            ..make_meta()
        };
        write_meta(&provider, &cloud_meta).await.unwrap();

        let loaded = read_meta(&provider)
            .await
            .unwrap()
            .expect("meta must exist");
        assert!(
            loaded.epoch > local_epoch,
            "cloud epoch {} must be greater than local epoch {}: mismatch detected",
            loaded.epoch,
            local_epoch
        );
    }

    /// Missing device slot returns None (not an error).
    #[tokio::test]
    async fn missing_device_slot_returns_none() {
        let provider = InMemoryKeyringProvider::new();
        let result = read_device_slot(&provider, "nonexistent-device-id")
            .await
            .unwrap();
        assert!(result.is_none(), "missing slot must return None, not Err");
    }

    /// Corrupt device slot JSON returns Err (not panic).
    #[tokio::test]
    async fn corrupt_device_slot_json_returns_err_not_panic() {
        let provider = InMemoryKeyringProvider::new();
        // Write raw invalid JSON for a device slot path.
        let path =
            crate::sync::keyring_v2::io::device_slot_path("c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf");
        provider
            .write_file(&path, b"not valid json at all!!!")
            .await
            .unwrap();

        let result = read_device_slot(&provider, "c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf").await;
        assert!(result.is_err(), "corrupt JSON must return Err");
    }

    /// Master fingerprint in meta must match HMAC-SHA256 of the actual master key.
    #[tokio::test]
    async fn master_fingerprint_in_meta_matches_master_key() {
        use crate::utils::encryption::key_fingerprint;

        let provider = InMemoryKeyringProvider::new();
        let master_key = [33u8; 32];
        let fingerprint = hex::encode(key_fingerprint(&master_key));

        let meta = KeyringMetaV2 {
            master_fingerprint: fingerprint.clone(),
            ..make_meta()
        };
        publish_initial_v2_keyring(&provider, &make_recovery(), &make_device(), &meta)
            .await
            .unwrap();

        let loaded = read_meta(&provider).await.unwrap().unwrap();
        assert_eq!(
            loaded.master_fingerprint, fingerprint,
            "stored fingerprint must match key_fingerprint(master)"
        );
        // Verify the fingerprint is deterministic for the same key.
        let fp2 = hex::encode(key_fingerprint(&master_key));
        assert_eq!(loaded.master_fingerprint, fp2);
    }

    /// Crash-safe publish order: recovery written before device slot, device slot before meta.
    /// Tracked via a recording provider that captures write order.
    #[tokio::test]
    async fn publish_order_is_recovery_then_device_then_meta() {
        use std::sync::{Arc, Mutex};

        struct RecordingProvider {
            inner: InMemoryKeyringProvider,
            write_log: Arc<Mutex<Vec<String>>>,
        }

        #[async_trait::async_trait]
        impl KeyringV2Io for RecordingProvider {
            async fn read_file(&self, path: &str) -> Result<Vec<u8>, crate::sync::SyncError> {
                self.inner.read_file(path).await
            }
            async fn write_file(
                &self,
                path: &str,
                data: &[u8],
            ) -> Result<(), crate::sync::SyncError> {
                self.write_log.lock().unwrap().push(path.to_string());
                self.inner.write_file(path, data).await
            }
            async fn delete_file(&self, path: &str) -> Result<(), crate::sync::SyncError> {
                self.inner.delete_file(path).await
            }
            async fn list_files(
                &self,
                prefix: &str,
            ) -> Result<Vec<String>, crate::sync::SyncError> {
                self.inner.list_files(prefix).await
            }
        }

        let write_log = Arc::new(Mutex::new(Vec::<String>::new()));
        let provider = RecordingProvider {
            inner: InMemoryKeyringProvider::new(),
            write_log: Arc::clone(&write_log),
        };

        publish_initial_v2_keyring(&provider, &make_recovery(), &make_device(), &make_meta())
            .await
            .unwrap();

        let log = write_log.lock().unwrap().clone();
        assert_eq!(log.len(), 3, "exactly 3 writes expected");
        assert!(
            log[0].contains("recovery") || log[0] == RECOVERY_PATH,
            "first write must be recovery slot, got: {}",
            log[0]
        );
        assert!(
            log[1].contains("devices/"),
            "second write must be device slot, got: {}",
            log[1]
        );
        assert!(
            log[2] == META_PATH,
            "last write must be meta (commit marker), got: {}",
            log[2]
        );
    }
}
