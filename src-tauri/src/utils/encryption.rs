use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

pub const NONCE_SIZE: usize = 12;
pub const TAG_SIZE: usize = 16;
pub const KEY_SIZE: usize = 32;
pub const SALT_SIZE: usize = 16;

// Argon2id KDF parameters for deriving the AES-256 encryption key.
//
// One preset:
// - FAST: m = 32 MiB, t = 2, p = 1 — meets OWASP minimum; all vaults use this.
//
// All blobs are self-describing: `wrap_key_with` (and now `wrap_key`) prepend
// the chosen params so `unwrap_key` derives with the exact params used at wrap
// time. See `KekBlob` below.
const KDF_FAST_M_COST_KIB: u32 = 32768;
const KDF_FAST_T_COST: u32 = 2;
const KDF_FAST_P_COST: u32 = 1;

/// Argon2id cost parameters for KEK derivation. Stored inside header-bearing
/// wrapped-key blobs so unwrap always uses the params the blob was wrapped with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    /// 32 MiB / t=2 / p=1 — the only preset; all vaults use this.
    pub const FAST: KdfParams = KdfParams {
        m_cost: KDF_FAST_M_COST_KIB,
        t_cost: KDF_FAST_T_COST,
        p_cost: KDF_FAST_P_COST,
    };
}

// Self-describing KEK-blob header.
//
// All blobs are header-bearing (67 bytes → 134 hex):
//   version(1) || m_cost_le(4) || t_cost(1) || p_cost(1) || nonce(12) || ct(32) || tag(16)
//
// LEGACY_BLOB_LEN (60) is the inner AEAD payload size (nonce+ct+tag); it is
// used in the HEADER_BLOB_LEN calculation and to reject old headerless blobs.
//
// The version byte lives in its OWN namespace — it is stored as hex in the boot
// file / DB settings and is NEVER routed through `decrypt_data_with_state`. Do
// not conflate it with the sync-envelope `VERSION_AES_GCM_V1`.
const KEK_BLOB_VERSION_1: u8 = 0x01;
const KEK_HEADER_LEN: usize = 7; // version + m(4) + t + p
const LEGACY_BLOB_LEN: usize = NONCE_SIZE + KEY_SIZE + TAG_SIZE; // 60
const HEADER_BLOB_LEN: usize = KEK_HEADER_LEN + LEGACY_BLOB_LEN; // 67

// Domain-separation labels for HKDF sub-key derivation.
// Version-suffixed so future key-rotation can introduce new labels without
// colliding with material derived from current labels.
const HKDF_INFO_SQLCIPHER: &[u8] = b"memlore-sqlcipher-v1";
const HKDF_INFO_SYNC: &[u8] = b"memlore-sync-envelope-v1";

/// Derive the SQLCipher page-encryption sub-key from the 32-byte Argon2id master.
///
/// HKDF salt is `None` — the master is already uniform Argon2id output, so
/// the Extract step is identity-like and Expand does the domain separation.
pub fn derive_sqlcipher_key(master: &[u8; KEY_SIZE]) -> Zeroizing<[u8; KEY_SIZE]> {
    let hk = Hkdf::<Sha256>::new(None, master);
    let mut out = Zeroizing::new([0u8; KEY_SIZE]);
    hk.expand(HKDF_INFO_SQLCIPHER, out.as_mut())
        .expect("HKDF expand: 32 bytes is always within the 255*HashLen limit");
    out
}

/// Derive the AES-256-GCM sync-envelope sub-key from the 32-byte Argon2id master.
pub fn derive_sync_key(master: &[u8; KEY_SIZE]) -> Zeroizing<[u8; KEY_SIZE]> {
    let hk = Hkdf::<Sha256>::new(None, master);
    let mut out = Zeroizing::new([0u8; KEY_SIZE]);
    hk.expand(HKDF_INFO_SYNC, out.as_mut())
        .expect("HKDF expand: 32 bytes is always within the 255*HashLen limit");
    out
}

/// Generate a random 16-byte salt for key derivation.
pub fn generate_encryption_salt() -> [u8; SALT_SIZE] {
    let mut salt = [0u8; SALT_SIZE];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Derive a 32-byte AES-256 key from a password and salt using Argon2id.
/// Returns `Zeroizing` so the key is wiped from memory when dropped.
pub fn derive_encryption_key(
    password: &str,
    salt: &[u8],
) -> Result<Zeroizing<[u8; KEY_SIZE]>, String> {
    derive_encryption_key_with(password, salt, KdfParams::FAST)
}

/// Derive a 32-byte AES-256 key with explicit Argon2id cost parameters.
pub fn derive_encryption_key_with(
    password: &str,
    salt: &[u8],
    p: KdfParams,
) -> Result<Zeroizing<[u8; KEY_SIZE]>, String> {
    let params = Params::new(p.m_cost, p.t_cost, p.p_cost, Some(KEY_SIZE))
        .map_err(|e| format!("Invalid KDF params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| format!("Key derivation failed: {e}"))?;
    Ok(key)
}

/// AES-256-GCM encrypt. Output layout: `nonce (12 bytes) || ciphertext || tag (16 bytes)`.
pub fn encrypt_data(key: &[u8; KEY_SIZE], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("Encryption failed: {e}"))?;
    let mut output = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Wrap (encrypt) a 32-byte entry-encryption key with a Key Encryption Key (KEK)
/// derived from `Argon2id(password, kek_salt)` using FAST params.
///
/// Output format: `version(1) || m_cost_le(4) || t_cost(1) || p_cost(1) ||
/// nonce(12) || ciphertext(32) || tag(16)` = 67 bytes, encoded as a hex string
/// of 134 characters (for TEXT storage in the settings table).
///
/// The KEK derivation uses a **separate** salt from the entry-encryption salt
/// and the password-hash salt — caller is responsible for generating and
/// persisting `kek_salt` before calling this.
pub fn wrap_key(
    entry_key: &[u8; KEY_SIZE],
    password: &str,
    kek_salt: &[u8],
) -> Result<String, String> {
    wrap_key_with(entry_key, password, kek_salt, KdfParams::FAST)
}

/// Wrap an entry key with explicit Argon2id params, producing a self-describing
/// blob: `version || m_le(4) || t || p || nonce || ct || tag` (67 bytes → 134 hex).
///
/// Unlike [`wrap_key`], the chosen params are embedded so [`unwrap_key`] derives
/// with the exact params used here, regardless of any global default.
pub fn wrap_key_with(
    entry_key: &[u8; KEY_SIZE],
    password: &str,
    kek_salt: &[u8],
    params: KdfParams,
) -> Result<String, String> {
    // The header stores t_cost / p_cost as a single byte each. Reject values that
    // would truncate: deriving with the full u32 but storing a truncated byte
    // would make unwrap re-derive a different KEK → silent lockout. FAST
    // (t=2/p=1) is well within range; this guards any future preset against
    // the truncation footgun. (m_cost is stored full 4-byte LE, so it needs
    // no such guard.)
    if params.t_cost > u8::MAX as u32 || params.p_cost > u8::MAX as u32 {
        return Err(format!(
            "KDF params out of storable range: t_cost={} p_cost={} (max {})",
            params.t_cost,
            params.p_cost,
            u8::MAX
        ));
    }
    let kek = derive_encryption_key_with(password, kek_salt, params)?;
    let encrypted_blob = encrypt_data(&kek, entry_key)?;
    let mut out = Vec::with_capacity(KEK_HEADER_LEN + encrypted_blob.len());
    out.push(KEK_BLOB_VERSION_1);
    out.extend_from_slice(&params.m_cost.to_le_bytes());
    out.push(params.t_cost as u8);
    out.push(params.p_cost as u8);
    out.extend_from_slice(&encrypted_blob);
    Ok(hex::encode(&out))
}

/// Determine the KDF params a decoded wrapped-key blob was produced with.
///
/// Discriminates by **length**:
/// - 60 bytes → old headerless blob (unsupported) → `Err`.
/// - 67 bytes → header-bearing → version byte validated, params parsed.
/// - anything else → `Err`.
pub fn parse_kek_params(blob: &[u8]) -> Result<KdfParams, String> {
    match blob.len() {
        LEGACY_BLOB_LEN => Err(format!(
            "Wrapped key has unexpected length: {} bytes (headerless blobs are no longer supported)",
            LEGACY_BLOB_LEN
        )),
        HEADER_BLOB_LEN => {
            if blob[0] != KEK_BLOB_VERSION_1 {
                return Err(format!("Unknown KEK blob version: {:#04x}", blob[0]));
            }
            let m_cost = u32::from_le_bytes([blob[1], blob[2], blob[3], blob[4]]);
            let t_cost = blob[5] as u32;
            let p_cost = blob[6] as u32;
            // The params are validated BEFORE they reach Argon2. The header sits
            // outside the AEAD tag and is consumed before authentication, so a
            // tampered/corrupted local or cloud blob is fully attacker-controlled
            // here. Two threats: (1) an enormous m_cost → multi-GiB allocation
            // (OOM/DoS) at unlock/re-pair; (2) below-floor params (e.g. m=8 KiB)
            // that a re-wrap path (recovery, which reads params from the PLAINTEXT
            // boot file) would otherwise bake into a downgraded KEK. The app only
            // ever emits exactly FAST (every call site resolves to a preset
            // constant or another parse_kek_params result), so anything that is
            // not exactly FAST is not app-produced and is rejected — no
            // ceiling/floor gap.
            let candidate = KdfParams {
                m_cost,
                t_cost,
                p_cost,
            };
            if candidate != KdfParams::FAST {
                return Err(format!(
                    "KEK params are not a supported preset: m={m_cost} t={t_cost} p={p_cost} \
                     (expected FAST m={} t={} p={})",
                    KdfParams::FAST.m_cost,
                    KdfParams::FAST.t_cost,
                    KdfParams::FAST.p_cost,
                ));
            }
            Ok(candidate)
        }
        other => Err(format!("Wrapped key has unexpected length: {other} bytes")),
    }
}

/// Unwrap a hex-encoded wrapped key blob back to the 32-byte entry key.
///
/// Returns an error if the password is wrong (AES-GCM authentication fails),
/// the hex is malformed, or the decrypted blob is not exactly 32 bytes.
pub fn unwrap_key(
    wrapped_hex: &str,
    password: &str,
    kek_salt: &[u8],
) -> Result<Zeroizing<[u8; KEY_SIZE]>, String> {
    let blob = hex::decode(wrapped_hex).map_err(|e| format!("Invalid wrapped key hex: {e}"))?;
    // Read the params embedded in the header, then strip the header before AES-GCM decrypt.
    let params = parse_kek_params(&blob)?;
    let ciphertext = if blob.len() == HEADER_BLOB_LEN {
        &blob[KEK_HEADER_LEN..]
    } else {
        &blob[..]
    };
    let kek = derive_encryption_key_with(password, kek_salt, params)?;
    let plaintext = decrypt_data(&kek, ciphertext)
        .map_err(|_| "Invalid password or corrupted wrapped key".to_string())?;
    if plaintext.len() != KEY_SIZE {
        return Err(format!(
            "Unwrapped key has wrong size: expected {KEY_SIZE} bytes, got {}",
            plaintext.len()
        ));
    }
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    key.copy_from_slice(&plaintext);
    Ok(key)
}

/// Deterministic, public fingerprint of a 32-byte encryption key.
///
/// Computed as `HMAC-SHA256(key, FINGERPRINT_CONTEXT)`. Used by the sync
/// engine (Chunk 3c) to verify that two devices share the same master key
/// **before** attempting to write peer-encrypted ciphertext back into the
/// local DB. A mismatch means the ciphertext we pulled cannot be
/// decrypted with the local key, so we must refuse ingest rather than
/// silently corrupt the DB.
///
/// Security notes:
/// - HMAC is a PRF. The 32-byte output reveals no information about the
///   key beyond "is it the same key as device B's?" — collision is
///   negligible at 256-bit output width.
/// - The context string is fixed so every device computes the same
///   fingerprint for the same key.
/// - The fingerprint is written to `SyncEntryPayload` in **plaintext** —
///   this is intentional. Anyone reading the sync folder already knows
///   it's an Memlore sync folder; the fingerprint adds no useful
///   information to an outside observer.
pub const KEY_FINGERPRINT_CONTEXT: &[u8] = b"memlore-sync-v1-key-fingerprint";

pub fn key_fingerprint(key: &[u8; KEY_SIZE]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(KEY_FINGERPRINT_CONTEXT);
    mac.finalize().into_bytes().into()
}

/// AES-256-GCM decrypt. Input must be `nonce (12 bytes) || ciphertext || tag (16 bytes)`.
pub fn decrypt_data(key: &[u8; KEY_SIZE], encrypted: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted.len() < NONCE_SIZE + TAG_SIZE {
        return Err(format!(
            "Encrypted data too short: {} bytes (minimum {})",
            encrypted.len(),
            NONCE_SIZE + TAG_SIZE
        ));
    }
    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("Decryption failed: {e}"))
}

// ─── Content-key helpers (T1) ────────────────────────────────────────────────
//
// The content key is a raw 32-byte CSPRNG key — no Argon2 derivation needed
// because the caller (master_key) is already uniformly random. Wrapping uses
// raw AES-256-GCM (encrypt_data / decrypt_data) exactly like the recovery slot.
//
// `wrap_content_key` returns `Vec<u8>` (raw bytes, NOT hex) so the caller
// controls the encoding for storage. Phase 2 will hex-encode it for the DB /
// boot file.

/// Generate a fresh random 32-byte content (DEK) key.
pub fn generate_content_key() -> Zeroizing<[u8; KEY_SIZE]> {
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    OsRng.fill_bytes(key.as_mut());
    key
}

/// Wrap a content key under the master key using raw AES-256-GCM.
///
/// No Argon2 derivation — `master` is already uniformly random Argon2id output,
/// so using it directly as the AES key is sound. Same rationale as the recovery
/// slot (`_recovery.json`).
///
/// Output is raw bytes (nonce || ct || tag = 60 bytes for a 32-byte plaintext).
pub fn wrap_content_key(
    master: &[u8; KEY_SIZE],
    content: &[u8; KEY_SIZE],
) -> Result<Vec<u8>, String> {
    encrypt_data(master, content.as_ref())
}

/// Unwrap a content key blob produced by [`wrap_content_key`].
///
/// Returns `Err` if the AEAD authentication fails (wrong master or corrupted
/// blob) or if the decrypted result is not exactly 32 bytes.
pub fn unwrap_content_key(
    master: &[u8; KEY_SIZE],
    blob: &[u8],
) -> Result<Zeroizing<[u8; KEY_SIZE]>, String> {
    let plain = decrypt_data(master, blob).map_err(|_| {
        "unwrap_content_key: authentication failed — wrong master or corrupted blob".to_string()
    })?;
    if plain.len() != KEY_SIZE {
        return Err(format!(
            "unwrap_content_key: decrypted payload has wrong size: expected {KEY_SIZE} bytes, got {}",
            plain.len()
        ));
    }
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    key.copy_from_slice(&plain);
    Ok(key)
}

// ─── Content-key list codec ──────────────────────────────────────────────────
//
// Compact encoding for the per-device boot file and DB setting.
//
// Format: concatenation of fixed-width 64-byte slots, hex-encoded.
//   Each slot: epoch(4 bytes BE) || wrapped_blob(60 bytes) = 64 bytes → 128 hex chars.
//
// `wrap_content_key` output is exactly 60 bytes (nonce=12 + ct=32 + tag=16),
// so every slot is exactly 64 raw bytes / 128 hex chars.
// The whole hex string length is `entries * 128`.

/// Bytes per slot in the binary codec: epoch(4) + wrapped_blob(60).
const CONTENT_KEY_SLOT_SIZE: usize = 4 + NONCE_SIZE + KEY_SIZE + TAG_SIZE; // 64
/// Hex chars per slot.
const CONTENT_KEY_SLOT_HEX: usize = CONTENT_KEY_SLOT_SIZE * 2; // 128

/// Encode a content-key list into a compact hex string for boot-file / DB storage.
///
/// Each entry is `epoch(4 bytes BE) || wrap_content_key(master, key)` = 64 raw bytes
/// → 128 hex chars. Entries are ordered by epoch ascending.
///
/// Returns an error if any epoch fails to wrap (AES-GCM should never fail here,
/// but propagating is the correct contract).
pub fn encode_content_key_list(
    master: &[u8; KEY_SIZE],
    keys: &std::collections::BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>>,
) -> Result<String, String> {
    let mut out = String::with_capacity(keys.len() * CONTENT_KEY_SLOT_HEX);
    for (epoch, key) in keys.iter() {
        let blob = wrap_content_key(master, key)?;
        if blob.len() != NONCE_SIZE + KEY_SIZE + TAG_SIZE {
            return Err(format!(
                "encode_content_key_list: unexpected blob size {} for epoch {epoch} \
                 (expected {})",
                blob.len(),
                NONCE_SIZE + KEY_SIZE + TAG_SIZE
            ));
        }
        let epoch_bytes = epoch.to_be_bytes();
        out.push_str(&hex::encode(epoch_bytes));
        out.push_str(&hex::encode(&blob));
    }
    Ok(out)
}

/// Decode a hex string produced by [`encode_content_key_list`] back into a key map.
///
/// Rejects inputs whose length is not a multiple of 128 hex chars (64 raw bytes per slot).
/// Returns an error if any slot fails to unwrap (wrong master key or corrupted blob).
pub fn decode_content_key_list(
    master: &[u8; KEY_SIZE],
    encoded: &str,
) -> Result<std::collections::BTreeMap<u32, zeroize::Zeroizing<[u8; KEY_SIZE]>>, String> {
    if encoded.len() % CONTENT_KEY_SLOT_HEX != 0 {
        return Err(format!(
            "decode_content_key_list: encoded length {} is not a multiple of {} \
             (corrupt or truncated list)",
            encoded.len(),
            CONTENT_KEY_SLOT_HEX
        ));
    }
    if encoded.is_empty() {
        return Err("decode_content_key_list: empty content-key list".to_string());
    }
    let mut map = std::collections::BTreeMap::new();
    let raw =
        hex::decode(encoded).map_err(|e| format!("decode_content_key_list: invalid hex: {e}"))?;
    for slot in raw.chunks_exact(CONTENT_KEY_SLOT_SIZE) {
        let epoch = u32::from_be_bytes([slot[0], slot[1], slot[2], slot[3]]);
        let blob = &slot[4..];
        let key = unwrap_content_key(master, blob)?;
        map.insert(epoch, key);
    }
    Ok(map)
}

// ─── Versioned envelope ──────────────────────────────────────────────────────
//
// Version byte prefix prepended to every envelope produced by the state-aware
// helpers below.  Old `encrypt_data` / `decrypt_data` are unchanged and keep
// their existing call sites; the new functions are the Phase-2+ entry points.
//
// These version bytes live in the **sync-envelope** namespace, separate from
// the KEK-blob version byte (also 0x01) used in `wrap_key` / `wrap_key_with`.
// Do NOT conflate the two: KEK blobs are hex-encoded in boot files / DB
// settings and NEVER flow through `decrypt_data_with_state`.
//
// Always encrypted: there is no plaintext (0x00) envelope. A 0x00 byte
// arriving on the wire is dead data — it falls through to `UnknownVersion`,
// never a case to handle.
// 0x01 — AES-256-GCM v1 (legacy format, pre-epoch-tag).
//         Bytes after the prefix are nonce(12) || ciphertext || tag(16).
//         Retained for legacy decode only; new writes use 0x02.
// 0x02 — AES-256-GCM v2, epoch-tagged (media/blob envelopes).
//         Bytes after the prefix are:
//           epoch(4 LE) || nonce(12) || ciphertext || tag(16).
//         The epoch selects the content key in the receiver's key list.
//         Entries do NOT use this format — they carry key_fingerprint instead.

const VERSION_AES_GCM_V1: u8 = 0x01;
/// Epoch-tagged AES-256-GCM v2 envelope (media/blob).
pub const VERSION_AES_GCM_V2_EPOCH: u8 = 0x02;
/// Number of bytes for the epoch field inside a V2 envelope.
const EPOCH_SIZE: usize = 4;

/// Structured error type for [`decrypt_data_with_state`].
///
/// The public `decrypt_data_with_state` maps these to `String` for Tauri
/// command compat. Phase 2 sync code imports this type directly to route
/// errors structurally.
#[derive(Debug)]
pub enum EnvelopeError {
    /// Unknown version byte (includes a stray `0x00` — plaintext envelopes
    /// are dead data now, not a mode to detect).
    UnknownVersion(u8),
    /// Epoch tag in a V2 envelope has no matching key in the key list.
    UnknownEpoch(u32),
    /// Envelope is empty (no version byte).
    Empty,
}

impl std::fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnvelopeError::UnknownVersion(v) => write!(f, "unknown envelope version: {v:#04x}"),
            EnvelopeError::UnknownEpoch(e) => write!(
                f,
                "unknown content-key epoch {e} — this device does not hold the content key \
                 for epoch {e} (device may have been revoked or key list is incomplete)"
            ),
            EnvelopeError::Empty => write!(f, "envelope is empty"),
        }
    }
}

/// Versioned encrypt (legacy V1 format).
///
/// Returns `[0x01] ++ encrypt_data(sync_sub_key, plaintext)`.
///
/// The sync sub-key is derived from the **latest** content key via `with_sync_key`.
/// This retains the pre-Phase-1 on-wire format so the existing sync engine
/// (which only understands `0x01`) continues to work unchanged.
///
/// For the epoch-tagged V2 format (`0x02`), use [`encrypt_data_with_state_epoch`].
pub fn encrypt_data_with_state(
    plaintext: &[u8],
    key_state: &crate::EncryptionKeyState,
) -> Result<Vec<u8>, String> {
    // V1 format — [0x01] ++ nonce(12) ++ ct ++ tag(16).
    key_state.with_sync_key(|k| {
        let inner = encrypt_data(k, plaintext)?;
        let mut out = Vec::with_capacity(1 + inner.len());
        out.push(VERSION_AES_GCM_V1);
        out.extend_from_slice(&inner);
        Ok(out)
    })
}

/// Versioned encrypt — epoch-tagged V2 format.
///
/// Returns `[0x02] ++ epoch(4 LE) ++ encrypt_data(sync_sub_key, plaintext)`.
///
/// The epoch and sync sub-key are taken from the **latest** content key via
/// `with_latest_sync_key`. Callers holding a reference to a specific epoch
/// (e.g. rotation re-encrypt) should call `encrypt_data` directly with the
/// key they have and build the envelope manually.
///
/// **Phase 2 note:** the sync engine will adopt this function once updated to
/// accept `0x02` envelopes. Until then, existing call sites use
/// [`encrypt_data_with_state`] (V1).
pub fn encrypt_data_with_state_epoch(
    plaintext: &[u8],
    key_state: &crate::EncryptionKeyState,
) -> Result<Vec<u8>, String> {
    // Stamp the latest epoch and derive the sync sub-key.
    key_state.with_latest_sync_key(|epoch, k| {
        let inner = encrypt_data(k, plaintext)?;
        let mut out = Vec::with_capacity(1 + EPOCH_SIZE + inner.len());
        out.push(VERSION_AES_GCM_V2_EPOCH);
        out.extend_from_slice(&epoch.to_le_bytes());
        out.extend_from_slice(&inner);
        Ok(out)
    })
}

/// Inner implementation returning the structured [`EnvelopeError`].
fn decrypt_data_with_state_inner(
    envelope: &[u8],
    key_state: &crate::EncryptionKeyState,
) -> Result<Vec<u8>, EnvelopeError> {
    if envelope.is_empty() {
        return Err(EnvelopeError::Empty);
    }
    let (version, rest) = envelope.split_first().expect("checked above");
    match *version {
        VERSION_AES_GCM_V1 => {
            // Legacy 0x01 format: no epoch tag in the wire format.
            // These envelopes were produced before epoch-tagged V2 was introduced,
            // so the content key epoch is unknown at decrypt time. After a key
            // rotation the "latest" sync key is no longer epoch 1, so we must try
            // every epoch's sync sub-key (ascending) until one succeeds.
            key_state
                .try_all_sync_keys(rest)
                .map_err(|_e| EnvelopeError::UnknownVersion(*version))
        }
        VERSION_AES_GCM_V2_EPOCH => {
            // V2 format: epoch(4 LE) || nonce(12) || ct || tag(16).
            // Minimum rest length: 4 (epoch) + 12 (nonce) + 16 (tag) = 32 bytes.
            if rest.len() < EPOCH_SIZE + NONCE_SIZE + TAG_SIZE {
                return Err(EnvelopeError::UnknownVersion(VERSION_AES_GCM_V2_EPOCH));
            }
            let epoch = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
            let inner = &rest[EPOCH_SIZE..];
            key_state
                .with_sync_key_for_epoch(epoch, |k| decrypt_data(k, inner))
                .map_err(|e| {
                    // Route unknown-epoch errors as UnknownEpoch; all others as UnknownVersion.
                    if e.contains("unknown content-key epoch") || e.contains("epoch") {
                        EnvelopeError::UnknownEpoch(epoch)
                    } else {
                        EnvelopeError::UnknownVersion(VERSION_AES_GCM_V2_EPOCH)
                    }
                })
        }
        other => Err(EnvelopeError::UnknownVersion(other)),
    }
}

/// Versioned decrypt.
///
/// * `0x01` prefix: legacy AES-256-GCM without epoch tag — tries every epoch's
///   sync key (ascending) so pre-rotation data survives after a key rotation.
///   Only produced by pre-Phase-2 code; new writes use `0x02`.
/// * `0x02` prefix: AES-256-GCM with 4-byte epoch tag — decrypts by selecting
///   the content key matching the epoch from the key list.
/// * Any other prefix — including a stray `0x00` from a pre-rewrite plaintext
///   vault — returns `Err("unknown envelope version: 0xNN")`. There is no
///   plaintext envelope format to read; a `0x00` byte is dead data, not a
///   mode to detect.
pub fn decrypt_data_with_state(
    envelope: &[u8],
    key_state: &crate::EncryptionKeyState,
) -> Result<Vec<u8>, String> {
    // Special-case the AES-GCM paths so inner decrypt errors pass through cleanly.
    if envelope.first() == Some(&VERSION_AES_GCM_V1) {
        let rest = &envelope[1..];
        // Legacy 0x01: no epoch tag — try every epoch's sync key (ascending)
        // so that pre-rotation data survives after a key rotation.
        return key_state.try_all_sync_keys(rest);
    }
    if envelope.first() == Some(&VERSION_AES_GCM_V2_EPOCH) {
        let rest = &envelope[1..];
        if rest.len() < EPOCH_SIZE + NONCE_SIZE + TAG_SIZE {
            return Err(format!(
                "V2 envelope too short: {} bytes after version byte (minimum {})",
                rest.len(),
                EPOCH_SIZE + NONCE_SIZE + TAG_SIZE
            ));
        }
        let epoch = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
        let inner = &rest[EPOCH_SIZE..];
        return key_state.with_sync_key_for_epoch(epoch, |k| decrypt_data(k, inner));
    }
    decrypt_data_with_state_inner(envelope, key_state).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_salt_is_16_bytes() {
        let salt = generate_encryption_salt();
        assert_eq!(salt.len(), SALT_SIZE);
    }

    #[test]
    fn test_generate_salt_is_random() {
        let salt1 = generate_encryption_salt();
        let salt2 = generate_encryption_salt();
        assert_ne!(salt1, salt2);
    }

    #[test]
    fn test_derive_key_is_32_bytes() {
        let salt = generate_encryption_salt();
        let key = derive_encryption_key("password", &salt).unwrap();
        assert_eq!(key.len(), KEY_SIZE);
    }

    #[test]
    fn test_derive_key_deterministic() {
        let salt = [1u8; SALT_SIZE];
        let key1 = derive_encryption_key("password", &salt).unwrap();
        let key2 = derive_encryption_key("password", &salt).unwrap();
        assert_eq!(*key1, *key2);
    }

    #[test]
    fn test_derive_key_different_passwords() {
        let salt = [1u8; SALT_SIZE];
        let key1 = derive_encryption_key("password1", &salt).unwrap();
        let key2 = derive_encryption_key("password2", &salt).unwrap();
        assert_ne!(*key1, *key2);
    }

    #[test]
    fn test_derive_key_different_salts() {
        let salt1 = [1u8; SALT_SIZE];
        let salt2 = [2u8; SALT_SIZE];
        let key1 = derive_encryption_key("password", &salt1).unwrap();
        let key2 = derive_encryption_key("password", &salt2).unwrap();
        assert_ne!(*key1, *key2);
    }

    #[test]
    fn test_derive_key_rejects_short_salt() {
        // Argon2id requires salt >= 8 bytes. A 4-byte salt must return Err, not panic.
        let salt = [0u8; 4];
        let result = derive_encryption_key("password", &salt);
        assert!(result.is_err());
    }

    #[test]
    fn test_derive_key_rejects_empty_salt() {
        let result = derive_encryption_key("password", &[]);
        assert!(result.is_err());
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"Hello, Memlore!";
        let encrypted = encrypt_data(&key, plaintext).unwrap();
        let decrypted = decrypt_data(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_produces_unique_ciphertext() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"same data";
        let enc1 = encrypt_data(&key, plaintext).unwrap();
        let enc2 = encrypt_data(&key, plaintext).unwrap();
        assert_ne!(enc1, enc2);
    }

    #[test]
    fn test_encrypt_nonce_uniqueness_many() {
        // Run 1000 encryptions with the same key/plaintext and verify all nonces are distinct.
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"payload";
        let mut seen_nonces: std::collections::HashSet<[u8; NONCE_SIZE]> =
            std::collections::HashSet::new();
        for _ in 0..1000 {
            let out = encrypt_data(&key, plaintext).unwrap();
            let mut nonce = [0u8; NONCE_SIZE];
            nonce.copy_from_slice(&out[..NONCE_SIZE]);
            assert!(
                seen_nonces.insert(nonce),
                "nonce collision after N iterations"
            );
        }
    }

    #[test]
    fn test_encrypt_output_layout() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"hello world";
        let encrypted = encrypt_data(&key, plaintext).unwrap();
        // Layout: nonce (12) || ciphertext (== plaintext length for GCM) || tag (16)
        assert_eq!(encrypted.len(), NONCE_SIZE + plaintext.len() + TAG_SIZE);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let key1 = derive_encryption_key("password1", &[1u8; SALT_SIZE]).unwrap();
        let key2 = derive_encryption_key("password2", &[1u8; SALT_SIZE]).unwrap();
        let encrypted = encrypt_data(&key1, b"secret").unwrap();
        let result = decrypt_data(&key2, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn test_encrypt_empty_data() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"";
        let encrypted = encrypt_data(&key, plaintext).unwrap();
        // Still has nonce + tag
        assert_eq!(encrypted.len(), NONCE_SIZE + TAG_SIZE);
        let decrypted = decrypt_data(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_large_data() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = vec![42u8; 100 * 1024]; // 100KB
        let encrypted = encrypt_data(&key, &plaintext).unwrap();
        let decrypted = decrypt_data(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_truncated_data_fails() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        // 5 bytes — shorter than nonce+tag minimum
        let truncated = vec![0u8; 5];
        let result = decrypt_data(&key, &truncated);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_just_under_minimum_fails() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        // nonce + tag - 1 byte — just below minimum
        let just_under = vec![0u8; NONCE_SIZE + TAG_SIZE - 1];
        let result = decrypt_data(&key, &just_under);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_corrupted_data_fails() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"important data";
        let mut encrypted = encrypt_data(&key, plaintext).unwrap();
        // Corrupt the ciphertext (bytes after the nonce)
        encrypted[NONCE_SIZE] ^= 0xFF;
        let result = decrypt_data(&key, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_corrupted_tag_fails() {
        let key = derive_encryption_key("password", &[1u8; SALT_SIZE]).unwrap();
        let plaintext = b"important data";
        let mut encrypted = encrypt_data(&key, plaintext).unwrap();
        // Corrupt the tag (last 16 bytes) — must fail authentication.
        let tag_start = encrypted.len() - TAG_SIZE;
        encrypted[tag_start] ^= 0xFF;
        let result = decrypt_data(&key, &encrypted);
        assert!(result.is_err());
    }

    // ─── wrap_key / unwrap_key ───────────────────────────────────────────────

    #[test]
    fn test_wrap_unwrap_key_roundtrip() {
        // Wrap a 32-byte entry key with a password, then unwrap it.
        let entry_key = [42u8; KEY_SIZE];
        let password = "test-password-long-enough";
        let kek_salt = [7u8; SALT_SIZE];

        let wrapped = wrap_key(&entry_key, password, &kek_salt).unwrap();
        let recovered = unwrap_key(&wrapped, password, &kek_salt).unwrap();

        assert_eq!(*recovered, entry_key);
    }

    #[test]
    fn test_wrap_key_wrong_password_fails() {
        let entry_key = [42u8; KEY_SIZE];
        let kek_salt = [7u8; SALT_SIZE];

        let wrapped = wrap_key(&entry_key, "correct-password-here", &kek_salt).unwrap();
        let result = unwrap_key(&wrapped, "wrong-password-here!", &kek_salt);

        assert!(result.is_err(), "wrong password must fail unwrap");
    }

    #[test]
    fn test_wrap_key_produces_hex_string() {
        let entry_key = [1u8; KEY_SIZE];
        let kek_salt = [2u8; SALT_SIZE];
        let wrapped = wrap_key(&entry_key, "password12345678", &kek_salt).unwrap();

        // `wrap_key` produces a FAST header-bearing blob:
        // version(1) + m_cost(4) + t(1) + p(1) + nonce(12) + ciphertext(32) + tag(16)
        // = 67 bytes → 134 hex chars
        assert_eq!(wrapped.len(), 134, "wrap_key must be 134 hex chars");
        assert!(
            wrapped.chars().all(|c| c.is_ascii_hexdigit()),
            "wrapped key must be all hex digits"
        );
    }

    // ─── Self-describing blob (KdfParams presets) ───────────────────────────

    #[test]
    fn fast_blob_is_header_bearing_and_roundtrips() {
        let entry_key = [9u8; KEY_SIZE];
        let kek_salt = [3u8; SALT_SIZE];
        let wrapped =
            wrap_key_with(&entry_key, "fast-pass-1234567", &kek_salt, KdfParams::FAST).unwrap();
        // version(1) + m_cost(4) + t(1) + p(1) + nonce(12) + ct(32) + tag(16)
        // = 67 bytes → 134 hex chars.
        assert_eq!(
            wrapped.len(),
            134,
            "header-bearing blob must be 134 hex chars"
        );
        let recovered = unwrap_key(&wrapped, "fast-pass-1234567", &kek_salt).unwrap();
        assert_eq!(*recovered, entry_key);
    }

    #[test]
    fn parse_kek_params_discriminates_by_length() {
        // 60-byte blob → Err (headerless blobs are no longer supported).
        let blob_60 = vec![0u8; LEGACY_BLOB_LEN];
        assert!(
            parse_kek_params(&blob_60).is_err(),
            "60-byte blob must be rejected"
        );

        // Header-bearing FAST blob → FAST.
        let entry_key = [1u8; KEY_SIZE];
        let kek_salt = [2u8; SALT_SIZE];
        let fast =
            wrap_key_with(&entry_key, "fast-pass-1234567", &kek_salt, KdfParams::FAST).unwrap();
        assert_eq!(
            parse_kek_params(&hex::decode(&fast).unwrap()).unwrap(),
            KdfParams::FAST
        );
    }

    #[test]
    fn legacy_blob_rejected_regardless_of_first_byte() {
        // A 60-byte blob is always rejected — length is the discriminator.
        // Even if the first byte happens to be the version sentinel (0x01),
        // a 60-byte payload cannot be a valid header-bearing blob.
        let blob_60 = vec![0x01u8; 60];
        assert!(
            parse_kek_params(&blob_60).is_err(),
            "60-byte blob must be rejected regardless of first byte"
        );
    }

    #[test]
    fn unwrap_rejects_unknown_kek_version() {
        // A 67-byte blob (header length) whose version byte is unknown must Err,
        // not silently mis-derive.
        let kek_salt = [2u8; SALT_SIZE];
        let mut bad = vec![0xFEu8]; // unknown version
        bad.extend_from_slice(&[0u8; 6]); // m/t/p header bytes
        bad.extend_from_slice(&[0u8; 60]); // nonce+ct+tag placeholder
        assert_eq!(bad.len(), 67);
        let hex_bad = hex::encode(&bad);
        let result = unwrap_key(&hex_bad, "any-password-1234", &kek_salt);
        assert!(result.is_err(), "unknown version byte must be rejected");
    }

    #[test]
    fn unwrap_rejects_blob_of_unexpected_length() {
        let kek_salt = [2u8; SALT_SIZE];
        let bad = hex::encode(vec![0u8; 40]); // neither 60 nor 67
        let result = unwrap_key(&bad, "any-password-1234", &kek_salt);
        assert!(
            result.is_err(),
            "blob of unexpected length must be rejected"
        );
    }

    #[test]
    fn parse_kek_params_rejects_out_of_range_m_cost() {
        // A tampered/corrupted 67-byte header could set an enormous m_cost. The
        // header is OUTSIDE the AEAD tag and is fed to Argon2 BEFORE any auth, so
        // an unbounded value would let a malicious cloud/local blob trigger a
        // multi-GiB allocation (OOM/DoS) at unlock/re-pair. parse_kek_params must
        // reject params outside the supported preset range before deriving.
        let mut blob = vec![KEK_BLOB_VERSION_1];
        blob.extend_from_slice(&u32::MAX.to_le_bytes()); // m_cost = 0xFFFFFFFF KiB
        blob.push(2); // t
        blob.push(1); // p
        blob.extend_from_slice(&[0u8; 60]); // nonce+ct+tag placeholder
        assert_eq!(blob.len(), 67);
        assert!(
            parse_kek_params(&blob).is_err(),
            "out-of-range m_cost must be rejected, not fed to Argon2"
        );
    }

    #[test]
    fn parse_kek_params_rejects_out_of_range_t_and_p() {
        // t_cost / p_cost above the supported maximum must also be rejected.
        let mut blob = vec![KEK_BLOB_VERSION_1];
        blob.extend_from_slice(&KdfParams::FAST.m_cost.to_le_bytes());
        blob.push(255); // t way above any preset
        blob.push(255); // p way above any preset
        blob.extend_from_slice(&[0u8; 60]);
        assert!(
            parse_kek_params(&blob).is_err(),
            "out-of-range t/p must be rejected"
        );
    }

    #[test]
    fn parse_kek_params_rejects_below_floor_params() {
        // The header sits OUTSIDE the AEAD tag (parsed before authentication), so
        // a tampered plaintext boot file could carry params *weaker* than any
        // preset (e.g. m=8 KiB). The app only ever emits FAST, so anything that
        // is not exactly FAST is not app-produced and must be rejected —
        // otherwise a re-wrap path (recovery) would silently bake a downgraded KEK.
        let mut blob = vec![KEK_BLOB_VERSION_1];
        blob.extend_from_slice(&8u32.to_le_bytes()); // m = 8 KiB — far below FAST
        blob.push(1); // t
        blob.push(1); // p
        blob.extend_from_slice(&[0u8; 60]);
        assert!(
            parse_kek_params(&blob).is_err(),
            "below-floor params must be rejected, not accepted as a weak KEK"
        );
    }

    #[test]
    fn parse_kek_params_accepts_fast_preset_exactly() {
        // The FAST preset must parse cleanly after the range guard.
        let mut blob = vec![KEK_BLOB_VERSION_1];
        blob.extend_from_slice(&KdfParams::FAST.m_cost.to_le_bytes());
        blob.push(KdfParams::FAST.t_cost as u8);
        blob.push(KdfParams::FAST.p_cost as u8);
        blob.extend_from_slice(&[0u8; 60]);
        assert_eq!(parse_kek_params(&blob).unwrap(), KdfParams::FAST);
    }

    #[test]
    fn every_preset_round_trips_through_parse() {
        // Guard rail: parse_kek_params accepts ONLY the FAST preset.
        // Every preset the app emits must round-trip cleanly — if a future preset
        // is added but not threaded through parse_kek_params, its blobs would
        // parse-reject at unwrap → silent lockout. This test forces that change to
        // update parse_kek_params (or this list) instead of bricking vaults. Also
        // pins t/p ≤ 255 (the header stores them as a single byte each).
        for params in [KdfParams::FAST] {
            let mut blob = vec![KEK_BLOB_VERSION_1];
            blob.extend_from_slice(&params.m_cost.to_le_bytes());
            blob.push(params.t_cost as u8);
            blob.push(params.p_cost as u8);
            blob.extend_from_slice(&[0u8; 60]);
            assert_eq!(
                parse_kek_params(&blob).unwrap(),
                params,
                "preset {params:?} must parse cleanly — thread it through parse_kek_params"
            );
            assert!(
                params.t_cost <= u8::MAX as u32 && params.p_cost <= u8::MAX as u32,
                "preset {params:?} t/p must fit in the single-byte header field"
            );
        }
    }

    #[test]
    fn parse_kek_params_rejects_legacy_60_byte() {
        // A 60-byte headerless blob must always be rejected — this format is no
        // longer supported. parse_kek_params must return Err, not fall back to
        // any preset.
        let blob_60 = vec![0xAAu8; LEGACY_BLOB_LEN];
        assert!(
            parse_kek_params(&blob_60).is_err(),
            "60-byte legacy blob must be rejected"
        );
    }

    #[test]
    fn parse_kek_params_rejects_high_params_header() {
        // A 67-byte header with the old removed preset params (m=65536, t=3, p=4)
        // must be rejected. This proves a tampered or pre-migration blob carrying
        // those params cannot be accepted — only FAST (m=32768, t=2, p=1) is valid.
        let old_m_cost: u32 = 65536; // removed preset: 64 MiB
        let old_t_cost: u8 = 3;
        let old_p_cost: u8 = 4;
        let mut blob = vec![KEK_BLOB_VERSION_1];
        blob.extend_from_slice(&old_m_cost.to_le_bytes());
        blob.push(old_t_cost);
        blob.push(old_p_cost);
        blob.extend_from_slice(&[0u8; LEGACY_BLOB_LEN]); // dummy AEAD payload
        assert_eq!(blob.len(), HEADER_BLOB_LEN);
        assert!(
            parse_kek_params(&blob).is_err(),
            "67-byte blob with removed preset params (m=65536,t=3,p=4) must be rejected"
        );
    }

    #[test]
    fn test_unwrap_key_invalid_hex_fails() {
        let kek_salt = [7u8; SALT_SIZE];
        let result = unwrap_key("not-hex!!!", "password12345678", &kek_salt);
        assert!(result.is_err());
    }

    #[test]
    fn test_wrap_key_different_passwords_produce_different_blobs() {
        let entry_key = [99u8; KEY_SIZE];
        let kek_salt = [3u8; SALT_SIZE];

        let w1 = wrap_key(&entry_key, "password-alpha-1234", &kek_salt).unwrap();
        let w2 = wrap_key(&entry_key, "password-beta-56789", &kek_salt).unwrap();

        assert_ne!(w1, w2, "different passwords must produce different blobs");
    }

    #[test]
    fn test_wrap_key_different_salts_produce_different_blobs() {
        let entry_key = [55u8; KEY_SIZE];

        let w1 = wrap_key(&entry_key, "same-password-here1", &[1u8; SALT_SIZE]).unwrap();
        let w2 = wrap_key(&entry_key, "same-password-here1", &[2u8; SALT_SIZE]).unwrap();

        assert_ne!(w1, w2, "different salts must produce different blobs");
    }

    // ─── HKDF sub-key derivation (Task 4.1) ──────────────────────────────────

    #[test]
    fn hkdf_sqlcipher_key_is_deterministic() {
        let master = [0x42u8; KEY_SIZE];
        let k1 = derive_sqlcipher_key(&master);
        let k2 = derive_sqlcipher_key(&master);
        assert_eq!(*k1, *k2);
    }

    #[test]
    fn hkdf_keys_are_32_bytes() {
        let master = [0x01u8; KEY_SIZE];
        assert_eq!(derive_sqlcipher_key(&master).len(), KEY_SIZE);
        assert_eq!(derive_sync_key(&master).len(), KEY_SIZE);
    }

    #[test]
    fn hkdf_keys_differ_for_different_labels() {
        let master = [0xAAu8; KEY_SIZE];
        let sqlcipher = derive_sqlcipher_key(&master);
        let sync = derive_sync_key(&master);
        assert_ne!(
            *sqlcipher, *sync,
            "different info labels must produce different keys"
        );
    }

    #[test]
    fn hkdf_keys_differ_for_different_masters() {
        let master_a = [0x11u8; KEY_SIZE];
        let master_b = [0x22u8; KEY_SIZE];
        assert_ne!(
            *derive_sqlcipher_key(&master_a),
            *derive_sqlcipher_key(&master_b),
            "different masters must produce different sub-keys"
        );
    }

    // ─── Versioned envelope tests (encrypt_data_with_state / decrypt_data_with_state) ──

    fn make_real_key_state() -> crate::EncryptionKeyState {
        let ks = crate::EncryptionKeyState::new();
        let key = zeroize::Zeroizing::new([0x42u8; KEY_SIZE]);
        ks.set_key(key).unwrap();
        ks
    }

    #[test]
    fn aes_gcm_envelope_has_v1_prefix() {
        let ks = make_real_key_state();
        let plaintext = b"encrypted payload";
        let envelope = encrypt_data_with_state(plaintext, &ks).unwrap();
        assert_eq!(
            envelope[0], VERSION_AES_GCM_V1,
            "first byte must be 0x01 for real-key mode (V1 legacy format, behavior-preserving)"
        );
    }

    #[test]
    fn aes_gcm_epoch_envelope_has_v2_prefix() {
        let ks = make_real_key_state();
        let plaintext = b"encrypted payload";
        let envelope = encrypt_data_with_state_epoch(plaintext, &ks).unwrap();
        assert_eq!(
            envelope[0], VERSION_AES_GCM_V2_EPOCH,
            "first byte must be 0x02 for real-key mode (epoch-tagged V2 format)"
        );
        // Bytes 1-4 are the epoch (u32 LE); for a freshly seeded state the epoch is 1.
        let epoch = u32::from_le_bytes([envelope[1], envelope[2], envelope[3], envelope[4]]);
        assert_eq!(epoch, 1, "newly seeded state must use epoch 1");
    }

    #[test]
    fn encrypt_decrypt_with_real_key_roundtrips() {
        let ks = make_real_key_state();
        let plaintext = b"encrypted roundtrip";
        let envelope = encrypt_data_with_state(plaintext, &ks).unwrap();
        let recovered = decrypt_data_with_state(&envelope, &ks).unwrap();
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn decrypt_rejects_unknown_version_prefix() {
        let ks = make_real_key_state();
        let bad_envelope = [0x99u8, 0xAA, 0xBB];
        let err = decrypt_data_with_state(&bad_envelope, &ks).unwrap_err();
        assert!(
            err.contains("unknown envelope version"),
            "error must mention unknown version, got: {err:?}"
        );
        assert!(
            err.contains("0x99"),
            "error must include the bad byte value, got: {err:?}"
        );
    }

    #[test]
    fn decrypt_rejects_a_stray_plaintext_envelope() {
        // Always encrypted: a 0x00 (plaintext) envelope can only be dead data
        // — a stray byte, a corrupted file, or a leftover from a pre-rewrite
        // vault. It must be rejected as an unknown version, never accepted.
        let ks = make_real_key_state();
        let stray = [0x00u8, b'h', b'i'];
        let err = decrypt_data_with_state(&stray, &ks).unwrap_err();
        assert!(
            err.contains("unknown envelope version"),
            "a 0x00 envelope must be rejected as unknown version, got: {err:?}"
        );
    }

    #[test]
    fn decrypt_empty_envelope_returns_error() {
        let ks = make_real_key_state();
        let err = decrypt_data_with_state(&[], &ks).unwrap_err();
        assert!(err.contains("empty"), "error must say envelope is empty");
    }

    // ── Fast edge-case KDF tests (no #[ignore]) ───────────────────────────────

    #[test]
    fn kdf_wrong_salt_size_returns_error_not_panic() {
        // Argon2id requires salt >= 8 bytes. Anything shorter must be Err.
        let result = derive_encryption_key("password", b"short");
        assert!(result.is_err(), "salt < 8 bytes must return Err, not panic");
    }

    #[test]
    fn derive_sqlcipher_subkey_differs_from_master() {
        use rand::RngCore;
        let mut master = [0u8; KEY_SIZE];
        OsRng.fill_bytes(&mut master);
        let sqlcipher = derive_sqlcipher_key(&master);
        assert_ne!(
            *sqlcipher, master,
            "sqlcipher sub-key must differ from master"
        );
    }

    #[test]
    fn derive_sync_subkey_differs_from_sqlcipher() {
        use rand::RngCore;
        let mut master = [0u8; KEY_SIZE];
        OsRng.fill_bytes(&mut master);
        let sqlcipher = derive_sqlcipher_key(&master);
        let sync = derive_sync_key(&master);
        assert_ne!(
            *sqlcipher, *sync,
            "sync sub-key must differ from sqlcipher sub-key (different HKDF info)"
        );
    }

    // ── T5 — Content-key wrap/unwrap and epoch-envelope tests ────────────────

    #[test]
    fn wrap_unwrap_content_key_roundtrip() {
        let master = [0xABu8; KEY_SIZE];
        let content = generate_content_key();
        let blob = wrap_content_key(&master, &content).unwrap();
        let recovered = unwrap_content_key(&master, &blob).unwrap();
        assert_eq!(*recovered, *content, "unwrapped key must match original");
    }

    #[test]
    fn unwrap_wrong_master_fails() {
        let master = [0x11u8; KEY_SIZE];
        let wrong_master = [0x22u8; KEY_SIZE];
        let content = generate_content_key();
        let blob = wrap_content_key(&master, &content).unwrap();
        let result = unwrap_content_key(&wrong_master, &blob);
        assert!(
            result.is_err(),
            "wrong master must fail AEAD authentication"
        );
    }

    #[test]
    fn epoch_envelope_roundtrip_and_version_byte() {
        let ks = make_real_key_state();
        let plaintext = b"epoch-tagged media blob";
        // Use the V2 epoch-tagged primitive.
        let envelope = encrypt_data_with_state_epoch(plaintext, &ks).unwrap();
        // V2 format: [0x02][epoch: u32 LE][nonce(12)][ct][tag(16)]
        assert_eq!(
            envelope[0], VERSION_AES_GCM_V2_EPOCH,
            "version byte must be 0x02"
        );
        let epoch = u32::from_le_bytes([envelope[1], envelope[2], envelope[3], envelope[4]]);
        assert_eq!(epoch, 1, "epoch must be 1 for fresh state");
        let recovered = decrypt_data_with_state(&envelope, &ks).unwrap();
        assert_eq!(recovered, plaintext, "decrypted plaintext must match");
    }

    #[test]
    fn decrypt_selects_key_by_epoch() {
        use crate::EncryptionKeyState;
        use std::collections::BTreeMap;

        // Build a state with two content keys and encrypt under each.
        let key1 = Zeroizing::new([0x11u8; KEY_SIZE]);
        let key2 = Zeroizing::new([0x22u8; KEY_SIZE]);
        let db_key = Zeroizing::new([0x55u8; KEY_SIZE]);

        let mut keys: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys.insert(1, Zeroizing::new(*key1));
        keys.insert(2, Zeroizing::new(*key2));

        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys, 2, db_key, Zeroizing::new([0u8; KEY_SIZE]))
            .unwrap();

        let plaintext = b"content encrypted with epoch 2";
        // Use the V2 epoch-tagged primitive to verify epoch selection.
        let envelope = encrypt_data_with_state_epoch(plaintext, &ks).unwrap();
        // Must use epoch 2 (latest).
        let epoch = u32::from_le_bytes([envelope[1], envelope[2], envelope[3], envelope[4]]);
        assert_eq!(epoch, 2, "encrypt must use the latest epoch");

        // Decrypt must round-trip.
        let recovered = decrypt_data_with_state(&envelope, &ks).unwrap();
        assert_eq!(recovered, plaintext);

        // Manually craft an epoch-1 envelope and verify it decrypts with key1.
        let sync1 = crate::utils::encryption::derive_sync_key(&key1);
        let inner1 = encrypt_data(&sync1, b"old epoch 1 data").unwrap();
        let mut ep1_env = vec![VERSION_AES_GCM_V2_EPOCH];
        ep1_env.extend_from_slice(&1u32.to_le_bytes());
        ep1_env.extend_from_slice(&inner1);
        let rec1 = decrypt_data_with_state(&ep1_env, &ks).unwrap();
        assert_eq!(rec1, b"old epoch 1 data");
    }

    #[test]
    fn decrypt_unknown_epoch_errors() {
        use crate::EncryptionKeyState;
        use std::collections::BTreeMap;

        let key1 = Zeroizing::new([0xAAu8; KEY_SIZE]);
        let db_key = Zeroizing::new([0xBBu8; KEY_SIZE]);
        let mut keys: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys.insert(1, Zeroizing::new(*key1));
        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys, 1, db_key, Zeroizing::new([0u8; KEY_SIZE]))
            .unwrap();

        // Craft an envelope with epoch 99 (not in the list).
        let sync_k = crate::utils::encryption::derive_sync_key(&[0xCCu8; KEY_SIZE]);
        let inner = encrypt_data(&sync_k, b"from unknown epoch").unwrap();
        let mut env = vec![VERSION_AES_GCM_V2_EPOCH];
        env.extend_from_slice(&99u32.to_le_bytes());
        env.extend_from_slice(&inner);

        let err = decrypt_data_with_state(&env, &ks).unwrap_err();
        assert!(
            err.contains("99") || err.contains("epoch"),
            "error must mention the unknown epoch, got: {err:?}"
        );
    }

    // ── I7: legacy 0x01 envelopes survive key rotation ───────────────────────

    /// Encrypt V1-style (0x01 envelope) under epoch-1 sync key, rotate to epoch
    /// 2, then verify decryption still succeeds.  This is the I7 regression test:
    /// before the fix `decrypt_data_with_state` used only the latest (epoch-2)
    /// sync key for 0x01 envelopes and failed.
    #[test]
    fn v1_envelope_decrypts_after_rotation() {
        use crate::EncryptionKeyState;
        use std::collections::BTreeMap;

        // ── Step 1: epoch-1 only (pre-rotation state) ──
        let key1 = Zeroizing::new([0x11u8; KEY_SIZE]);
        let db_key = Zeroizing::new([0x55u8; KEY_SIZE]);
        let mut keys1: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys1.insert(1, Zeroizing::new(*key1));
        let ks = EncryptionKeyState::new();
        ks.set_content_state(keys1, 1, db_key.clone(), Zeroizing::new([0u8; KEY_SIZE]))
            .unwrap();

        // Produce a V1 (0x01) envelope using the pre-rotation state.
        let plaintext = b"old data before rotation";
        let envelope = encrypt_data_with_state(plaintext, &ks).unwrap();
        assert_eq!(envelope[0], VERSION_AES_GCM_V1, "must be a 0x01 envelope");

        // Verify it decrypts before rotation (sanity check).
        let recovered_pre = decrypt_data_with_state(&envelope, &ks).unwrap();
        assert_eq!(
            recovered_pre, plaintext,
            "pre-rotation decrypt must succeed"
        );

        // ── Step 2: rotate — add epoch 2, set latest = 2 ──
        let key2 = Zeroizing::new([0x22u8; KEY_SIZE]);
        let mut keys2: BTreeMap<u32, Zeroizing<[u8; KEY_SIZE]>> = BTreeMap::new();
        keys2.insert(1, Zeroizing::new(*key1));
        keys2.insert(2, Zeroizing::new(*key2));
        ks.set_content_state(keys2, 2, db_key, Zeroizing::new([0u8; KEY_SIZE]))
            .unwrap();

        // Decrypt the old epoch-1 V1 envelope with the rotated state.
        // Before the I7 fix this would fail because only epoch-2's sync key was tried.
        let recovered_post = decrypt_data_with_state(&envelope, &ks)
            .expect("I7: 0x01 envelope must decrypt after rotation to epoch 2");
        assert_eq!(
            recovered_post, plaintext,
            "post-rotation V1 decrypt must return original plaintext"
        );
    }

    // ── Nightly KDF correctness tests (slow — use full Argon2id params) ───────
    // Run with: cargo test -- --ignored full_kdf

    /// Full KDF password mode: setup + lock + unlock must work with real Argon2id cost.
    /// Expected runtime: ~1-2s (32 MiB × t=2 × p=1 — FAST params).
    #[test]
    #[ignore]
    fn full_kdf_setup_and_unlock_roundtrip() {
        let salt = generate_encryption_salt();
        let key = derive_encryption_key("fullkdfpassword1", &salt).unwrap();
        assert_eq!(key.len(), KEY_SIZE);

        let wrapped = wrap_key(&key, "fullkdfpassword1", &salt).unwrap();
        assert_eq!(wrapped.len(), 134);

        let unwrapped = unwrap_key(&wrapped, "fullkdfpassword1", &salt).unwrap();
        assert_eq!(
            *unwrapped, *key,
            "full KDF unlock must recover identical key"
        );
    }

    /// Full KDF key derivation: output is correct length and deterministic.
    #[test]
    #[ignore]
    fn full_kdf_derive_key_correct_length_and_deterministic() {
        let salt = [7u8; SALT_SIZE];
        let k1 = derive_encryption_key("fullkdfpassword1", &salt).unwrap();
        let k2 = derive_encryption_key("fullkdfpassword1", &salt).unwrap();
        assert_eq!(k1.len(), KEY_SIZE);
        assert_eq!(*k1, *k2, "full KDF must be deterministic");
    }

    /// Full KDF password change: old and new wrapping both work.
    #[test]
    #[ignore]
    fn full_kdf_password_change_rewrap() {
        let salt1 = generate_encryption_salt();
        let key = derive_encryption_key("oldpassword1", &salt1).unwrap();
        let wrapped_old = wrap_key(&key, "oldpassword1", &salt1).unwrap();

        let salt2 = generate_encryption_salt();
        let wrapped_new = wrap_key(&key, "newpassword1", &salt2).unwrap();

        // Old wrapping still works.
        let k1 = unwrap_key(&wrapped_old, "oldpassword1", &salt1).unwrap();
        assert_eq!(*k1, *key);

        // New wrapping works.
        let k2 = unwrap_key(&wrapped_new, "newpassword1", &salt2).unwrap();
        assert_eq!(*k2, *key, "new password must unwrap same master key");

        // Cross-check: wrong passwords rejected.
        assert!(unwrap_key(&wrapped_new, "oldpassword1", &salt2).is_err());
        assert!(unwrap_key(&wrapped_old, "newpassword1", &salt1).is_err());
    }

    // ─── Content-key list codec tests ────────────────────────────────────────

    #[test]
    fn content_key_list_codec_roundtrip_single_epoch() {
        use rand::RngCore;
        let mut master = Zeroizing::new([0u8; KEY_SIZE]);
        OsRng.fill_bytes(master.as_mut());

        let v1 = generate_content_key();
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1u32, Zeroizing::new(*v1));

        let encoded = encode_content_key_list(&master, &keys).unwrap();
        assert_eq!(
            encoded.len(),
            CONTENT_KEY_SLOT_HEX,
            "single entry must be exactly {CONTENT_KEY_SLOT_HEX} hex chars"
        );

        let decoded = decode_content_key_list(&master, &encoded).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(*decoded[&1], *v1, "decoded key must match original");
    }

    #[test]
    fn content_key_list_codec_roundtrip_multiple_epochs() {
        use rand::RngCore;
        let mut master = Zeroizing::new([0u8; KEY_SIZE]);
        OsRng.fill_bytes(master.as_mut());

        let v1 = generate_content_key();
        let v2 = generate_content_key();
        let v3 = generate_content_key();
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1u32, Zeroizing::new(*v1));
        keys.insert(2u32, Zeroizing::new(*v2));
        keys.insert(3u32, Zeroizing::new(*v3));

        let encoded = encode_content_key_list(&master, &keys).unwrap();
        assert_eq!(
            encoded.len(),
            3 * CONTENT_KEY_SLOT_HEX,
            "three entries must be exactly {} hex chars",
            3 * CONTENT_KEY_SLOT_HEX
        );

        let decoded = decode_content_key_list(&master, &encoded).unwrap();
        assert_eq!(decoded.len(), 3);
        assert_eq!(*decoded[&1], *v1);
        assert_eq!(*decoded[&2], *v2);
        assert_eq!(*decoded[&3], *v3);
    }

    #[test]
    fn content_key_list_codec_wrong_master_rejected() {
        use rand::RngCore;
        let mut master = Zeroizing::new([0u8; KEY_SIZE]);
        OsRng.fill_bytes(master.as_mut());
        let mut wrong_master = Zeroizing::new([0u8; KEY_SIZE]);
        OsRng.fill_bytes(wrong_master.as_mut());

        let v1 = generate_content_key();
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1u32, Zeroizing::new(*v1));

        let encoded = encode_content_key_list(&master, &keys).unwrap();
        let err = decode_content_key_list(&wrong_master, &encoded).unwrap_err();
        assert!(
            err.contains("authentication failed") || err.contains("Decryption failed"),
            "wrong master must be rejected, got: {err}"
        );
    }

    #[test]
    fn content_key_list_codec_truncated_rejected() {
        use rand::RngCore;
        let mut master = Zeroizing::new([0u8; KEY_SIZE]);
        OsRng.fill_bytes(master.as_mut());

        let v1 = generate_content_key();
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(1u32, Zeroizing::new(*v1));

        let encoded = encode_content_key_list(&master, &keys).unwrap();
        // Truncate by 1 hex char — must produce an error
        let truncated = &encoded[..encoded.len() - 1];
        let err = decode_content_key_list(&master, truncated).unwrap_err();
        assert!(
            err.contains("multiple of") || err.contains("invalid hex"),
            "truncated input must be rejected, got: {err}"
        );
    }
}

/// Fast KDF helpers for tests — cheap Argon2id params (m=4096, t=1, p=1).
/// Never use these outside `#[cfg(test)]` — they are cryptographically weak.
#[cfg(test)]
pub mod test_helpers {
    use super::*;

    const TEST_M_COST_KIB: u32 = 4096;
    const TEST_T_COST: u32 = 1;
    const TEST_P_COST: u32 = 1;

    /// Derive a 32-byte key with cheap Argon2id params. ~1ms vs ~1s for full params.
    pub fn cheap_derive_key(
        password: &str,
        salt: &[u8],
    ) -> Result<Zeroizing<[u8; KEY_SIZE]>, String> {
        let params = Params::new(TEST_M_COST_KIB, TEST_T_COST, TEST_P_COST, Some(KEY_SIZE))
            .map_err(|e| format!("Invalid test KDF params: {e}"))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut key = Zeroizing::new([0u8; KEY_SIZE]);
        argon2
            .hash_password_into(password.as_bytes(), salt, key.as_mut())
            .map_err(|e| format!("Cheap key derivation failed: {e}"))?;
        Ok(key)
    }

    /// Wrap a 32-byte key using cheap KDF. Returns 120-char hex string.
    pub fn cheap_wrap_key(
        entry_key: &[u8; KEY_SIZE],
        password: &str,
        kek_salt: &[u8],
    ) -> Result<String, String> {
        let kek = cheap_derive_key(password, kek_salt)?;
        let encrypted_blob = encrypt_data(&kek, entry_key)?;
        Ok(hex::encode(&encrypted_blob))
    }

    /// Unwrap a hex-encoded wrapped key blob using cheap KDF.
    pub fn cheap_unwrap_key(
        wrapped_hex: &str,
        password: &str,
        kek_salt: &[u8],
    ) -> Result<Zeroizing<[u8; KEY_SIZE]>, String> {
        let blob = hex::decode(wrapped_hex).map_err(|e| format!("Invalid wrapped key hex: {e}"))?;
        let kek = cheap_derive_key(password, kek_salt)?;
        let plaintext = decrypt_data(&kek, &blob)
            .map_err(|_| "Invalid password or corrupted wrapped key (cheap_unwrap)".to_string())?;
        if plaintext.len() != KEY_SIZE {
            return Err(format!(
                "Unwrapped key has wrong size: expected {KEY_SIZE} bytes, got {}",
                plaintext.len()
            ));
        }
        let mut key = Zeroizing::new([0u8; KEY_SIZE]);
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    #[test]
    fn cheap_kdf_roundtrip() {
        let salt = generate_encryption_salt();
        let mut entry_key = [0u8; KEY_SIZE];
        use rand::RngCore;
        OsRng.fill_bytes(&mut entry_key);

        let wrapped = cheap_wrap_key(&entry_key, "testpassword1", &salt).unwrap();
        assert_eq!(wrapped.len(), 120, "wrapped hex must be 120 chars");

        let unwrapped = cheap_unwrap_key(&wrapped, "testpassword1", &salt).unwrap();
        assert_eq!(*unwrapped, entry_key);
    }

    #[test]
    fn cheap_kdf_wrong_password_rejected() {
        let salt = generate_encryption_salt();
        let entry_key = [42u8; KEY_SIZE];

        let wrapped = cheap_wrap_key(&entry_key, "correctpass1", &salt).unwrap();
        let err = cheap_unwrap_key(&wrapped, "wrongpassword1", &salt).unwrap_err();
        assert!(
            err.contains("Invalid password") || err.contains("corrupted"),
            "expected auth error, got: {err}"
        );
    }

    #[test]
    fn cheap_kdf_deterministic() {
        let salt = [5u8; SALT_SIZE];
        let k1 = cheap_derive_key("mypassword1", &salt).unwrap();
        let k2 = cheap_derive_key("mypassword1", &salt).unwrap();
        assert_eq!(*k1, *k2);
    }

    #[test]
    fn cheap_kdf_different_from_full_kdf() {
        let salt = [3u8; SALT_SIZE];
        let cheap = cheap_derive_key("password123", &salt).unwrap();
        let full = derive_encryption_key("password123", &salt).unwrap();
        // Different params → different output (both are Argon2id but different cost → different hash)
        assert_ne!(*cheap, *full, "cheap and full KDF must differ");
    }
}
