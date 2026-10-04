//! Encryption primitives now live in `memlore-core`; re-exported here so existing
//! `crate::utils::encryption::*` paths keep working.

pub use memlore_core::encryption::*;

/// Fast KDF helpers for tests — cheap Argon2id params (m=4096, t=1, p=1).
/// Never use these outside `#[cfg(test)]` — they are cryptographically weak.
#[cfg(test)]
pub mod test_helpers {
    use super::*;
    use aes_gcm::aead::OsRng;
    use argon2::{Algorithm, Argon2, Params, Version};
    use zeroize::Zeroizing;

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
