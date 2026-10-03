//! wasm-bindgen surface of `memlore-core` for the web app (v1, read-only).
//!
//! Design rules:
//! - Raw keys never cross into JS. [`KeyRing`] owns the master key and the
//!   content-key list inside Rust; JS only holds an opaque handle.
//! - Every export is a thin wrapper over a plain Rust function returning
//!   `Result<_, String>`, so the logic is testable natively (`JsError` cannot be
//!   built outside wasm32).
//! - Structured data crosses as JSON strings (no extra dependencies).
//! - Time is always a parameter; nothing here reads a clock or generates ids.
//! - Error strings carry no key material, no plaintext and no fragments of the
//!   rejected input (JSON errors report only a class, line and column).
//! - Untrusted input is size-capped before any decrypt or parse
//!   ([`MAX_ENTRY_BYTES`], [`MAX_MEDIA_BYTES`], [`MAX_BIN_BYTES`],
//!   [`MAX_JSON_BYTES`]); over-limit input returns an error and no data.
//!
//! Key lifetime (the web layer must honour this):
//! - A [`KeyRing`] keeps its keys until `lock()`, `free()` or GC. The web layer
//!   MUST call `lock()` on the idle timeout and on tab hide, and must treat any
//!   wasm trap as a lock (drop the ring and re-unlock).
//! - Passwords and recovery phrases passed in as `&str` stay in the JS heap; Rust
//!   cannot zeroize them.
//!
//! Test sealers: `sealEntry` and `sealMedia` can forge validly encrypted files
//! under the user's content key, so they are exported only with the cargo
//! feature `test-sealers` (off by default, off in production builds). JS tests
//! that need them must build a separate package with
//! `scripts/web-wasm.sh --test-sealers` (writes `web/src/core/pkg-test/`).

use memlore_core::encryption::{KEY_SIZE, VERSION_AES_GCM_V2_EPOCH};
use memlore_core::entry_sync::PAYLOAD_SCHEMA_VERSION;
use memlore_core::envelope::{self, EnvelopeError};
use memlore_core::key_state::ContentKeyList;
use memlore_core::keyring_types::{
    DeviceSlotV2, KeyringMetaV2, RecoveryMarker, KEYRING_V2_VERSION, RECOVERY_MARKER_VERSION,
};
use memlore_core::metadata::{
    compute_diff, compute_journal_diff, merge_metadata_lww, DeviceMetadata, EntryMetadata,
    SyncedJournalSummary,
};
use memlore_core::recovery::{validate_recovery_mnemonic, RECOVERY_WORD_COUNT};
use memlore_core::sync_control::{
    authorize_recovery_push, RecoveryOwnerPermit, SyncControlV1, SYNC_CONTROL_VERSION,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

fn js_err(message: String) -> JsError {
    JsError::new(&message)
}

fn envelope_err(e: EnvelopeError) -> String {
    e.to_string()
}

/// Largest entry file accepted: core `MAX_PAYLOAD_BYTES` (32 MiB) plus 1 MiB of
/// envelope, metadata and AEAD overhead.
pub const MAX_ENTRY_BYTES: usize = 33 * 1024 * 1024;
/// Largest media or thumbnail file accepted.
pub const MAX_MEDIA_BYTES: usize = 256 * 1024 * 1024;
/// Largest device-root bin (`tags.bin`, `settings.bin`, `templates.bin`) accepted.
pub const MAX_BIN_BYTES: usize = 16 * 1024 * 1024;
/// Largest JSON text accepted by any parse or load function.
pub const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

/// Reject oversized untrusted input before touching it. Length-only, no data.
fn check_len(what: &str, len: usize, max: usize) -> Result<(), String> {
    if len > max {
        return Err(format!("{what} too large: {len} bytes (max {max})"));
    }
    Ok(())
}

fn parse_json<T: DeserializeOwned>(what: &str, json: &str) -> Result<T, String> {
    check_len(what, json.len(), MAX_JSON_BYTES)?;
    serde_json::from_str(json).map_err(|e| {
        // Never `e.to_string()`: serde_json can echo fragments of the input.
        let class = match e.classify() {
            serde_json::error::Category::Io => "io",
            serde_json::error::Category::Syntax => "syntax",
            serde_json::error::Category::Data => "data",
            serde_json::error::Category::Eof => "unexpected end of input",
        };
        format!(
            "invalid {what}: {class} error at line {} column {}",
            e.line(),
            e.column()
        )
    })
}

fn to_json<T: Serialize>(what: &str, value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("cannot serialize {what}: {e}"))
}

/// JS numbers are f64; accept only exact non-negative integers in the safe range.
fn unix_seconds(what: &str, value: f64) -> Result<i64, String> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=MAX_SAFE).contains(&value) {
        return Err(format!("{what} must be a non-negative integer"));
    }
    Ok(value as i64)
}

// ---------------------------------------------------------------------------
// KeyRing
// ---------------------------------------------------------------------------

/// Key material held by a [`KeyRing`]. Plain Rust so it is testable natively.
#[derive(Default)]
struct KeyRingState {
    master: Option<Zeroizing<[u8; KEY_SIZE]>>,
    list: Option<ContentKeyList>,
}

const LOCKED: &str = "key ring is locked";

impl KeyRingState {
    fn with_master(master: Zeroizing<[u8; KEY_SIZE]>) -> Self {
        Self {
            master: Some(master),
            list: None,
        }
    }

    fn master(&self) -> Result<&[u8; KEY_SIZE], String> {
        self.master.as_deref().ok_or_else(|| LOCKED.to_string())
    }

    /// Seed epoch 1 = master. Refuses when a list is already loaded: that would downgrade the ring.
    fn seed_master_only(&mut self) -> Result<(), String> {
        let list = self.master().map(master_only_list)?;
        if self.list.is_some() {
            return Err("content key list is already loaded".to_string());
        }
        self.list = Some(list);
        Ok(())
    }

    fn list(&self) -> Result<&ContentKeyList, String> {
        if self.master.is_none() {
            return Err(LOCKED.to_string());
        }
        self.list
            .as_ref()
            .ok_or_else(|| "content keys are not loaded".to_string())
    }

    fn lock(&mut self) {
        // Dropping zeroizes: the master and every content key are `Zeroizing`.
        self.master = None;
        self.list = None;
    }
}

fn key_ring_from_recovery(
    phrase: &str,
    wrapped_master_hex: &str,
    expected_fingerprint_hex: &str,
) -> Result<KeyRingState, String> {
    let master =
        envelope::unwrap_master_with_recovery(phrase, wrapped_master_hex).map_err(envelope_err)?;
    envelope::verify_master_fingerprint(&master, expected_fingerprint_hex).map_err(envelope_err)?;
    Ok(KeyRingState::with_master(master))
}

/// The content-key list of a pre-content-key vault whose `_content.json` is ABSENT: epoch 1 is
/// the master key itself, `latest = 1` (desktop `onboard_complete_inner` absent branch,
/// `commands/crypto.rs:2639-2656`; same seed as core `EncryptionKeyState::set_key`,
/// `key_state.rs:97-109`). `db_key` is the zero placeholder, as in `envelope::load_content_list`.
fn master_only_list(master: &[u8; KEY_SIZE]) -> ContentKeyList {
    let mut keys = std::collections::BTreeMap::new();
    keys.insert(1u32, Zeroizing::new(*master));
    ContentKeyList {
        keys,
        latest: 1,
        db_key: Zeroizing::new([0u8; KEY_SIZE]),
        master: Zeroizing::new(*master),
    }
}

/// Opaque handle to the vault keys. The master key and the content-key list live
/// inside Rust only; no export returns key bytes.
#[wasm_bindgen]
pub struct KeyRing {
    state: KeyRingState,
}

#[wasm_bindgen]
impl KeyRing {
    /// Unwrap the master key from the recovery slot with the 24-word phrase and
    /// check it against `KeyringMetaV2.master_fingerprint`.
    #[wasm_bindgen(js_name = fromRecovery)]
    pub fn from_recovery(
        phrase: &str,
        wrapped_master_hex: &str,
        expected_fingerprint_hex: &str,
    ) -> Result<KeyRing, JsError> {
        key_ring_from_recovery(phrase, wrapped_master_hex, expected_fingerprint_hex)
            .map(|state| KeyRing { state })
            .map_err(js_err)
    }

    /// Unwrap the master key from its password-wrapped local copy.
    #[wasm_bindgen(js_name = unlockLocal)]
    pub fn unlock_local(
        wrapped_hex: &str,
        password: &str,
        kek_salt: &[u8],
    ) -> Result<KeyRing, JsError> {
        envelope::unlock_local(wrapped_hex, password, kek_salt)
            .map(|master| KeyRing {
                state: KeyRingState::with_master(master),
            })
            .map_err(|e| js_err(envelope_err(e)))
    }

    /// Wrap the master key under `password` for local storage (hex). The caller
    /// supplies `kek_salt` and must store it next to the result.
    #[wasm_bindgen(js_name = wrapLocal)]
    pub fn wrap_local(&self, password: &str, kek_salt: &[u8]) -> Result<String, JsError> {
        self.state
            .master()
            .and_then(|m| envelope::wrap_master_local(m, password, kek_salt).map_err(envelope_err))
            .map_err(js_err)
    }

    /// Build the content-key list from `_content.json` text.
    #[wasm_bindgen(js_name = loadContentList)]
    pub fn load_content_list(&mut self, content_json: &str) -> Result<(), JsError> {
        let list = check_len("content list", content_json.len(), MAX_JSON_BYTES)
            .and_then(|()| self.state.master())
            .and_then(|m| envelope::load_content_list(content_json, m).map_err(envelope_err))
            .map_err(js_err)?;
        self.state.list = Some(list);
        Ok(())
    }

    /// Seed the content-key list for a vault whose `_content.json` is CONFIRMED absent
    /// (pre-content-key vault): epoch 1 = master. Call this ONLY on a confirmed "not found",
    /// never on a read error (that would "succeed" with the wrong key on a vault that has a
    /// random content key).
    #[wasm_bindgen(js_name = loadMasterOnly)]
    pub fn load_master_only(&mut self) -> Result<(), JsError> {
        self.state.seed_master_only().map_err(js_err)
    }

    /// Zeroize every key. Later calls on this ring return an error.
    pub fn lock(&mut self) {
        self.state.lock();
    }

    #[wasm_bindgen(getter, js_name = isLocked)]
    pub fn is_locked(&self) -> bool {
        self.state.master.is_none()
    }
}

// ---------------------------------------------------------------------------
// Mnemonic and fingerprint
// ---------------------------------------------------------------------------

fn mnemonic_ok(phrase: &str) -> bool {
    validate_recovery_mnemonic(phrase).is_ok()
}

/// True for a valid 24-word BIP39 recovery phrase.
#[wasm_bindgen(js_name = validateMnemonic)]
pub fn validate_mnemonic(phrase: &str) -> bool {
    mnemonic_ok(phrase)
}

/// Check the ring's master key against `KeyringMetaV2.master_fingerprint`.
#[wasm_bindgen(js_name = verifyMasterFingerprint)]
pub fn verify_master_fingerprint(ring: &KeyRing, expected_hex: &str) -> Result<(), JsError> {
    ring.state
        .master()
        .and_then(|m| envelope::verify_master_fingerprint(m, expected_hex).map_err(envelope_err))
        .map_err(js_err)
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/// Plaintext of one opened entry file.
#[wasm_bindgen(getter_with_clone)]
pub struct OpenedEntry {
    /// `serde_json` of `EntryMetadata`.
    #[wasm_bindgen(js_name = metadataJson)]
    pub metadata_json: String,
    /// Raw Yjs full-state bytes (empty when the entry has no body yet).
    pub yjs: Vec<u8>,
}

fn open_entry_inner(state: &KeyRingState, bytes: &[u8]) -> Result<OpenedEntry, String> {
    check_len("entry file", bytes.len(), MAX_ENTRY_BYTES)?;
    let opened = envelope::open_entry(state.list()?, bytes).map_err(envelope_err)?;
    let metadata_json = String::from_utf8(opened.metadata_json)
        .map_err(|_| "entry metadata is not valid UTF-8".to_string())?;
    Ok(OpenedEntry {
        metadata_json,
        yjs: opened.yjs,
    })
}

fn open_bare_inner(
    state: &KeyRingState,
    bytes: &[u8],
    device_bin: bool,
) -> Result<Vec<u8>, String> {
    if device_bin {
        check_len("device bin", bytes.len(), MAX_BIN_BYTES)?;
    } else {
        check_len("media file", bytes.len(), MAX_MEDIA_BYTES)?;
    }
    let list = state.list()?;
    let out = if device_bin {
        envelope::open_device_bin(list, bytes)
    } else {
        envelope::open_media(list, bytes)
    };
    out.map_err(envelope_err)
}

/// Open `<device>/entries/<entryId>.bin`.
#[wasm_bindgen(js_name = openEntry)]
pub fn open_entry(ring: &KeyRing, bytes: &[u8]) -> Result<OpenedEntry, JsError> {
    open_entry_inner(&ring.state, bytes).map_err(js_err)
}

/// Open media or a thumbnail (`0x01` legacy or `0x02` epoch envelope).
#[wasm_bindgen(js_name = openMedia)]
pub fn open_media(ring: &KeyRing, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    open_bare_inner(&ring.state, bytes, false).map_err(js_err)
}

/// Open a device-root bin (`tags.bin`, `settings.bin`, `templates.bin`); returns
/// the JSON plaintext bytes.
#[wasm_bindgen(js_name = openDeviceBin)]
pub fn open_device_bin(ring: &KeyRing, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    open_bare_inner(&ring.state, bytes, true).map_err(js_err)
}

// ---------------------------------------------------------------------------
// Sealers
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "test-sealers"))]
fn seal_entry_inner(
    state: &KeyRingState,
    metadata_json: &str,
    yjs: &[u8],
) -> Result<Vec<u8>, String> {
    envelope::seal_entry(state.list()?, metadata_json.as_bytes(), yjs).map_err(envelope_err)
}

fn seal_media_inner(
    state: &KeyRingState,
    plaintext: &[u8],
    thumb: bool,
) -> Result<Vec<u8>, String> {
    let list = state.list()?;
    let out = if thumb {
        envelope::seal_thumb(list, plaintext)
    } else {
        envelope::seal_media(list, plaintext)
    };
    out.map_err(envelope_err)
}

/// TEST FIXTURES ONLY (feature `test-sealers`). The web app never writes
/// protocol entry payloads (it writes outbox intents); this exists so tests can
/// build entry files.
#[cfg(feature = "test-sealers")]
#[wasm_bindgen(js_name = sealEntry)]
pub fn seal_entry(ring: &KeyRing, metadata_json: &str, yjs: &[u8]) -> Result<Vec<u8>, JsError> {
    seal_entry_inner(&ring.state, metadata_json, yjs).map_err(js_err)
}

/// TEST FIXTURES ONLY (feature `test-sealers`). Production media goes through
/// `sealOutboxMedia`.
#[cfg(feature = "test-sealers")]
#[wasm_bindgen(js_name = sealMedia)]
pub fn seal_media(ring: &KeyRing, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    seal_media_inner(&ring.state, plaintext, false).map_err(js_err)
}

/// Seal media bytes for an outbox upload (thin wrapper over core `seal_media`).
#[wasm_bindgen(js_name = sealOutboxMedia)]
pub fn seal_outbox_media(ring: &KeyRing, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    seal_media_inner(&ring.state, plaintext, false).map_err(js_err)
}

/// Seal a JPEG thumbnail for an outbox upload (thin wrapper over core `seal_thumb`).
#[wasm_bindgen(js_name = sealOutboxThumb)]
pub fn seal_outbox_thumb(ring: &KeyRing, jpeg: &[u8]) -> Result<Vec<u8>, JsError> {
    seal_media_inner(&ring.state, jpeg, true).map_err(js_err)
}

// ---------------------------------------------------------------------------
// Manifest and metadata
// ---------------------------------------------------------------------------

fn parse_manifest_inner(json: &str) -> Result<String, String> {
    let manifest: DeviceMetadata = parse_json("manifest", json)?;
    to_json("manifest", &manifest)
}

fn compute_diff_inner(local_json: &str, remote_json: &str) -> Result<String, String> {
    let local: DeviceMetadata = parse_json("local manifest", local_json)?;
    let remote: DeviceMetadata = parse_json("remote manifest", remote_json)?;
    let diff = compute_diff(&local, &remote);
    to_json(
        "diff",
        &serde_json::json!({
            "to_pull": diff.to_pull,
            "to_delete_locally": diff.to_delete_locally,
            "unchanged": diff.unchanged,
        }),
    )
}

fn compute_journal_diff_inner(local_json: &str, remote_json: &str) -> Result<String, String> {
    let local: Vec<SyncedJournalSummary> = parse_json("local journals", local_json)?;
    let remote: Vec<SyncedJournalSummary> = parse_json("remote journals", remote_json)?;
    let diff = compute_journal_diff(&local, &remote);
    to_json(
        "journal diff",
        &serde_json::json!({
            "to_pull": diff.to_pull,
            "to_delete_locally": diff.to_delete_locally,
            "unchanged": diff.unchanged,
        }),
    )
}

fn merge_metadata_lww_inner(local_json: &str, remote_json: &str) -> Result<String, String> {
    let local: EntryMetadata = parse_json("local metadata", local_json)?;
    let remote: EntryMetadata = parse_json("remote metadata", remote_json)?;
    if local.entry_id != remote.entry_id {
        return Err("cannot merge metadata of different entries".to_string());
    }
    to_json("metadata", &merge_metadata_lww(&local, &remote))
}

/// Parse and normalize a `metadata.json` manifest (plain JSON, not encrypted).
/// There is deliberately no manifest serializer: the web never writes one.
#[wasm_bindgen(js_name = parseManifest)]
pub fn parse_manifest(json: &str) -> Result<String, JsError> {
    parse_manifest_inner(json).map_err(js_err)
}

/// Remote-to-local entry diff: `{to_pull, to_delete_locally: [[id, ts]], unchanged}`.
#[wasm_bindgen(js_name = computeDiff)]
pub fn compute_diff_js(local_json: &str, remote_json: &str) -> Result<String, JsError> {
    compute_diff_inner(local_json, remote_json).map_err(js_err)
}

/// Remote-to-local journal diff over two JSON arrays of journal summaries.
#[wasm_bindgen(js_name = computeJournalDiff)]
pub fn compute_journal_diff_js(local_json: &str, remote_json: &str) -> Result<String, JsError> {
    compute_journal_diff_inner(local_json, remote_json).map_err(js_err)
}

/// Last-write-wins merge of two `EntryMetadata` JSON objects for the same entry.
#[wasm_bindgen(js_name = mergeMetadataLww)]
pub fn merge_metadata_lww_js(local_json: &str, remote_json: &str) -> Result<String, JsError> {
    merge_metadata_lww_inner(local_json, remote_json).map_err(js_err)
}

// ---------------------------------------------------------------------------
// Sync control and keyring JSON
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermitDto {
    job_id: i64,
    owner_device_id: String,
    operation: String,
    recovery_generation: u64,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorizeInput {
    marker: Option<RecoveryMarker>,
    cloud_generation: u64,
    local_generation: u64,
    permit: Option<PermitDto>,
}

fn parse_sync_control_inner(json: &str) -> Result<String, String> {
    let control: SyncControlV1 = parse_json("sync control", json)?;
    control.validate()?;
    to_json("sync control", &control)
}

fn authorize_push_inner(input_json: &str) -> Result<(), String> {
    let input: AuthorizeInput = parse_json("authorize input", input_json)?;
    if let Some(marker) = &input.marker {
        marker.validate()?;
    }
    let permit = input.permit.map(|p| RecoveryOwnerPermit {
        job_id: p.job_id,
        owner_device_id: p.owner_device_id,
        operation: p.operation,
        recovery_generation: p.recovery_generation,
        nonce: p.nonce,
    });
    authorize_recovery_push(
        input.marker.as_ref(),
        input.cloud_generation,
        input.local_generation,
        permit.as_ref(),
    )
}

fn parse_keyring_meta_inner(json: &str) -> Result<String, String> {
    let meta: KeyringMetaV2 = parse_json("keyring meta", json)?;
    meta.validate()?;
    to_json("keyring meta", &meta)
}

fn parse_device_slot_inner(json: &str) -> Result<String, String> {
    let slot: DeviceSlotV2 = parse_json("device slot", json)?;
    slot.validate()?;
    to_json("device slot", &slot)
}

fn build_device_slot_inner(
    device_id: &str,
    name: &str,
    created_at: f64,
    last_seen_at: f64,
) -> Result<String, String> {
    let slot = DeviceSlotV2 {
        version: KEYRING_V2_VERSION,
        device_id: device_id.to_string(),
        name: name.to_string(),
        created_at: unix_seconds("created_at", created_at)?,
        last_seen_at: unix_seconds("last_seen_at", last_seen_at)?,
    };
    slot.validate()?;
    to_json("device slot", &slot)
}

fn known_versions_inner() -> Result<String, String> {
    to_json(
        "versions",
        &serde_json::json!({
            "payload_schema_version": PAYLOAD_SCHEMA_VERSION,
            "keyring_version": KEYRING_V2_VERSION,
            "content_list_version": KEYRING_V2_VERSION,
            "recovery_marker_version": RECOVERY_MARKER_VERSION,
            "sync_control_version": SYNC_CONTROL_VERSION,
            "envelope_versions": [0x01, VERSION_AES_GCM_V2_EPOCH],
            "recovery_word_count": RECOVERY_WORD_COUNT,
        }),
    )
}

/// Parse and validate `.meta/control.json`.
#[wasm_bindgen(js_name = parseSyncControl)]
pub fn parse_sync_control(json: &str) -> Result<String, JsError> {
    parse_sync_control_inner(json).map_err(js_err)
}

/// Decide whether a push is allowed. Input JSON:
/// `{marker, cloud_generation, local_generation, permit}` (marker and permit may
/// be null). `Ok` means allowed; the error string is the refusal reason.
#[wasm_bindgen(js_name = authorizePush)]
pub fn authorize_push(input_json: &str) -> Result<(), JsError> {
    authorize_push_inner(input_json).map_err(js_err)
}

/// Parse and validate `.meta/keyring/_meta.json`.
#[wasm_bindgen(js_name = parseKeyringMeta)]
pub fn parse_keyring_meta(json: &str) -> Result<String, JsError> {
    parse_keyring_meta_inner(json).map_err(js_err)
}

/// Parse and validate `.meta/keyring/devices/<id>.json`.
#[wasm_bindgen(js_name = parseDeviceSlot)]
pub fn parse_device_slot(json: &str) -> Result<String, JsError> {
    parse_device_slot_inner(json).map_err(js_err)
}

/// Build a device slot JSON. Timestamps are Unix seconds supplied by the caller.
#[wasm_bindgen(js_name = buildDeviceSlot)]
pub fn build_device_slot(
    device_id: &str,
    name: &str,
    created_at: f64,
    last_seen_at: f64,
) -> Result<String, JsError> {
    build_device_slot_inner(device_id, name, created_at, last_seen_at).map_err(js_err)
}

/// Every schema, keyring and envelope version this core understands (JSON), for
/// the format guard.
#[wasm_bindgen(js_name = knownVersions)]
pub fn known_versions() -> Result<String, JsError> {
    known_versions_inner().map_err(js_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use memlore_core::encryption::{encrypt_data, generate_encryption_salt, key_fingerprint};
    use memlore_core::recovery::{derive_recovery_key, generate_recovery_mnemonic};

    fn list_state() -> KeyRingState {
        let master = Zeroizing::new([7u8; KEY_SIZE]);
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1, Zeroizing::new([1u8; KEY_SIZE]));
        let list = ContentKeyList {
            keys,
            latest: 1,
            db_key: Zeroizing::new([0u8; KEY_SIZE]),
            master: master.clone(),
        };
        KeyRingState {
            master: Some(master),
            list: Some(list),
        }
    }

    const META: &str = r#"{"entry_id":"e1","device_id":"d","updated_at":5,"entry_date":1,"created_at":1,"journal_id":"j","journal_name":null,"title":null,"preview_text":null,"content_text":null,"location_label":null,"location_address":null,"weather_summary":null,"weather_icon":null,"latitude":null,"longitude":null,"emotion":null,"is_favorite":false,"is_deleted":false}"#;

    #[test]
    fn seal_open_round_trip_through_wrappers() {
        let s = list_state();
        let sealed = seal_entry_inner(&s, META, b"yjs").unwrap();
        let opened = open_entry_inner(&s, &sealed).unwrap();
        assert_eq!(opened.metadata_json, META);
        assert_eq!(opened.yjs, b"yjs");

        let media = seal_media_inner(&s, b"img", false).unwrap();
        assert_eq!(media[0], VERSION_AES_GCM_V2_EPOCH);
        assert_eq!(open_bare_inner(&s, &media, false).unwrap(), b"img");
        let thumb = seal_media_inner(&s, b"jpg", true).unwrap();
        assert_eq!(open_bare_inner(&s, &thumb, true).unwrap(), b"jpg");
    }

    #[test]
    fn locked_ring_rejects_every_operation_and_drops_keys() {
        let mut s = list_state();
        s.lock();
        assert!(s.master.is_none() && s.list.is_none());
        assert_eq!(open_entry_inner(&s, b"XJS1").err().unwrap(), LOCKED);
        assert_eq!(seal_media_inner(&s, b"x", false).unwrap_err(), LOCKED);
        assert_eq!(s.master().unwrap_err(), LOCKED);
    }

    #[test]
    fn ring_without_content_list_cannot_open() {
        let s = KeyRingState::with_master(Zeroizing::new([7u8; KEY_SIZE]));
        assert_eq!(
            open_bare_inner(&s, &[1], false).unwrap_err(),
            "content keys are not loaded"
        );
    }

    #[test]
    fn from_recovery_checks_phrase_and_fingerprint() {
        let phrase = generate_recovery_mnemonic().unwrap();
        assert!(mnemonic_ok(&phrase));
        assert!(!mnemonic_ok("abandon abandon"));
        let master = [3u8; KEY_SIZE];
        let rk = derive_recovery_key(&validate_recovery_mnemonic(&phrase).unwrap());
        let wrapped = hex::encode(encrypt_data(&rk, &master).unwrap());
        let fp = hex::encode(key_fingerprint(&master));

        let ring = key_ring_from_recovery(&phrase, &wrapped, &fp).unwrap();
        assert_eq!(ring.master().unwrap(), &master);
        let err = key_ring_from_recovery(&phrase, &wrapped, &"0".repeat(64)).err();
        assert_eq!(err.unwrap(), "master key fingerprint mismatch");
        assert!(key_ring_from_recovery("nope", &wrapped, &fp).is_err());
    }

    #[test]
    fn master_only_list_seeds_epoch_one_with_the_master() {
        let mut s = KeyRingState::with_master(Zeroizing::new([7u8; KEY_SIZE]));
        let list = s.master().map(master_only_list).unwrap();
        assert_eq!(list.latest, 1);
        assert_eq!(list.keys.len(), 1);
        assert_eq!(*list.keys[&1], [7u8; KEY_SIZE]);
        s.list = Some(list);
        // The ring now seals and opens with epoch 1 = master.
        let media = seal_media_inner(&s, b"img", false).unwrap();
        assert_eq!(open_bare_inner(&s, &media, false).unwrap(), b"img");
        s.lock();
        assert_eq!(s.master().map(master_only_list).err().unwrap(), LOCKED);
    }

    #[test]
    fn seed_master_only_refuses_to_replace_a_loaded_list() {
        let mut s = KeyRingState::with_master(Zeroizing::new([7u8; KEY_SIZE]));
        s.seed_master_only().unwrap();
        let err = s.seed_master_only().unwrap_err();
        assert!(err.contains("already loaded"));
        assert_eq!(s.list.as_ref().unwrap().latest, 1);
        s.lock();
        assert_eq!(s.seed_master_only().unwrap_err(), LOCKED);
    }

    #[test]
    fn wrap_and_unlock_local_round_trip() {
        let master = [4u8; KEY_SIZE];
        let salt = generate_encryption_salt();
        let wrapped = envelope::wrap_master_local(&master, "pw", &salt).unwrap();
        let back = envelope::unlock_local(&wrapped, "pw", &salt).unwrap();
        assert_eq!(*back, master);
        assert!(envelope::unlock_local(&wrapped, "bad", &salt).is_err());
    }

    #[test]
    fn manifest_diff_and_journal_diff() {
        let local = r#"{"device_id":"a","entries":[],"journals":[],"generated_at":1}"#;
        let remote = r#"{"device_id":"b","entries":[{"entry_id":"e1","updated_at":9,"local_version":1,"is_deleted":false}],"journals":[],"generated_at":2}"#;
        assert!(parse_manifest_inner(local).is_ok());
        assert!(parse_manifest_inner("{}").is_err());
        let v: serde_json::Value =
            serde_json::from_str(&compute_diff_inner(local, remote).unwrap()).unwrap();
        assert_eq!(v["to_pull"], serde_json::json!(["e1"]));

        let jr = r#"[{"journal_id":"j1","updated_at":3,"local_version":1,"is_deleted":false}]"#;
        let v: serde_json::Value =
            serde_json::from_str(&compute_journal_diff_inner("[]", jr).unwrap()).unwrap();
        assert_eq!(v["to_pull"], serde_json::json!(["j1"]));
        assert_eq!(v["unchanged"], 0);
    }

    #[test]
    fn merge_rejects_different_entries_and_prefers_newer() {
        let newer = META.replace("\"updated_at\":5", "\"updated_at\":9");
        let merged = merge_metadata_lww_inner(META, &newer).unwrap();
        assert!(merged.contains("\"updated_at\":9"));
        let other = META.replace("\"e1\"", "\"e2\"");
        assert!(merge_metadata_lww_inner(META, &other).is_err());
    }

    #[test]
    fn sync_control_and_authorize_push() {
        let ok = r#"{"version":1,"recovery_generation":0,"recovery_lease":null,"updated_at":1}"#;
        assert!(parse_sync_control_inner(ok).is_ok());
        assert!(parse_sync_control_inner(&ok.replace("\"version\":1", "\"version\":9")).is_err());

        let allowed = r#"{"marker":null,"cloud_generation":2,"local_generation":2,"permit":null}"#;
        assert!(authorize_push_inner(allowed).is_ok());
        let behind = allowed.replace("\"local_generation\":2", "\"local_generation\":1");
        assert!(authorize_push_inner(&behind)
            .unwrap_err()
            .contains("generation mismatch"));
    }

    #[test]
    fn keyring_meta_and_device_slot() {
        let meta = format!(
            r#"{{"version":2,"epoch":1,"master_fingerprint":"{}","content_epoch":1,"created_at":1,"updated_at":2}}"#,
            "a".repeat(64)
        );
        assert!(parse_keyring_meta_inner(&meta).is_ok());
        assert!(parse_keyring_meta_inner(&meta.replace("\"version\":2", "\"version\":3")).is_err());

        let built = build_device_slot_inner("12345678-aaaa", "Web", 10.0, 20.0).unwrap();
        let reparsed: serde_json::Value =
            serde_json::from_str(&parse_device_slot_inner(&built).unwrap()).unwrap();
        assert_eq!(reparsed["name"], "Web");
        assert!(build_device_slot_inner("x", "Web", 1.0, 1.0).is_err());
        assert!(build_device_slot_inner("12345678-aaaa", "Web", 1.5, 1.0).is_err());
        assert!(build_device_slot_inner("12345678-aaaa", "Web", f64::NAN, 1.0).is_err());
        assert!(build_device_slot_inner("12345678-aaaa", "Web", -1.0, 1.0).is_err());
    }

    #[test]
    fn check_len_allows_the_limit_and_rejects_above() {
        assert!(check_len("x", 4, 4).is_ok());
        let err = check_len("x", 5, 4).unwrap_err();
        assert_eq!(err, "x too large: 5 bytes (max 4)");
    }

    #[test]
    fn oversized_inputs_are_rejected_before_decrypt_or_parse() {
        let s = list_state();
        let entry = vec![0u8; MAX_ENTRY_BYTES + 1];
        assert!(open_entry_inner(&s, &entry)
            .err()
            .unwrap()
            .contains("too large"));
        let bin = vec![0u8; MAX_BIN_BYTES + 1];
        assert!(open_bare_inner(&s, &bin, true)
            .unwrap_err()
            .contains("too large"));
        // Cheap at-limit case: passes the cap, then fails on the envelope itself.
        let at_limit = vec![0u8; MAX_BIN_BYTES];
        let err = open_bare_inner(&s, &at_limit, true).unwrap_err();
        assert!(!err.contains("too large"));

        let json = format!("[{}]", " ".repeat(MAX_JSON_BYTES));
        assert!(parse_manifest_inner(&json)
            .unwrap_err()
            .contains("too large"));
        let at_limit = " ".repeat(MAX_JSON_BYTES);
        let err = parse_manifest_inner(&at_limit).unwrap_err();
        assert!(!err.contains("too large"));
    }

    #[test]
    fn limits_are_consistent_with_core() {
        assert!(MAX_ENTRY_BYTES as u64 > memlore_core::entry_sync::MAX_PAYLOAD_BYTES);
    }

    #[test]
    fn json_errors_do_not_echo_input() {
        let bad = r#"{"device_id":"a","entries":[],"journals":[],"generated_at":"SECRET-VALUE"}"#;
        let err = parse_manifest_inner(bad).unwrap_err();
        assert!(err.starts_with("invalid manifest: data error at line 1 column "));
        assert!(!err.contains("SECRET-VALUE"));
        let err = parse_manifest_inner("{SECRET-VALUE").unwrap_err();
        assert!(err.starts_with("invalid manifest: syntax error at line 1"));
        assert!(!err.contains("SECRET"));
    }

    #[test]
    fn known_versions_lists_current_formats() {
        let v: serde_json::Value = serde_json::from_str(&known_versions_inner().unwrap()).unwrap();
        assert_eq!(v["payload_schema_version"], PAYLOAD_SCHEMA_VERSION);
        assert_eq!(v["keyring_version"], KEYRING_V2_VERSION);
        assert_eq!(v["envelope_versions"], serde_json::json!([1, 2]));
    }
}
