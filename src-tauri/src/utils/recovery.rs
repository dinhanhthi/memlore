//! BIP39 recovery phrase generation, validation, and key derivation.
//!
//! A 24-word English BIP39 mnemonic (256-bit entropy) is generated on first
//! setup. The phrase can be used to derive a 32-byte recovery key via
//! HKDF-SHA256, which wraps the master key in the recovery slot
//! (`.meta/keyring/_recovery.json`).
//!
//! # Security notes
//!
//! - 24 words = 256-bit entropy. No Argon2id is applied to the mnemonic
//!   because BIP39 entropy is already strong enough for direct HKDF input.
//! - `Zeroizing` erases the recovery key from memory on drop.
//! - `validate_recovery_mnemonic` normalizes input (trim, lowercase, collapse
//!   whitespace) before parsing so users pasting with newlines or extra spaces
//!   still succeed.

use bip39::{Language, Mnemonic};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

/// BIP39 word count for 256-bit entropy (24 words).
pub const RECOVERY_WORD_COUNT: usize = 24;

/// Entropy byte length for 24 BIP39 words. 256 bits = 32 bytes.
const ENTROPY_BYTES: usize = 32;

/// HKDF domain-separation label for the recovery key.
/// Versioned so a future rotation scheme can introduce a new label.
pub const HKDF_INFO_RECOVERY: &[u8] = b"memlore-recovery-v1";

/// Generate a random 24-word English BIP39 mnemonic phrase.
///
/// Returns the phrase wrapped in [`Zeroizing`] so the secret bytes are wiped
/// from memory on drop. The inner `String` can be borrowed as `&str` via
/// normal deref coercion (`&*phrase` or by passing `&phrase` where `&str` is
/// expected).
/// Fails if the OS RNG is unavailable (extremely rare).
pub fn generate_recovery_mnemonic() -> Result<Zeroizing<String>, String> {
    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    rand::thread_rng().fill_bytes(entropy.as_mut());
    let mnemonic = Mnemonic::from_entropy_in(Language::English, entropy.as_ref())
        .map_err(|e| format!("BIP39 generation failed: {e}"))?;
    Ok(Zeroizing::new(
        mnemonic.words().collect::<Vec<_>>().join(" "),
    ))
    // entropy is dropped & zeroed here; returned Zeroizing<String> wipes on drop
}

/// Validate a candidate recovery phrase.
///
/// Accepts phrases with any combination of leading/trailing whitespace,
/// newlines, and multi-space separators (common when pasting from paper
/// or a notes app). Lowercases the whole string before parsing.
///
/// Returns the parsed [`Mnemonic`] so the caller can immediately derive
/// the recovery key without re-parsing.
pub fn validate_recovery_mnemonic(phrase: &str) -> Result<Mnemonic, String> {
    // Build the normalized phrase directly into a Zeroizing buffer so no
    // per-word String copies linger in memory unzeroized.
    //
    // The old approach — `split_whitespace().map(str::to_lowercase).collect::<Vec<_>>().join(" ")`
    // — created 24 heap-allocated Strings via `str::to_lowercase`, collected
    // them into a Vec<String>, then dropped both un-zeroized. Only the final
    // joined string was zeroized.
    //
    // The new approach appends each word directly into the Zeroizing<String>
    // buffer and lowercases the freshly-appended tail in-place via
    // `make_ascii_lowercase`, keeping every byte of the recovery phrase inside
    // the Zeroizing allocation.
    //
    // SAFETY: `make_ascii_lowercase` operates byte-by-byte on the ASCII range
    // only. BIP39 English words are pure ASCII (a-z), so the tail slice
    // `[start..]` is a valid UTF-8 boundary (we just pushed it) and ASCII
    // lowercase is byte-stable for characters in this range.
    let mut normalized: Zeroizing<String> = Zeroizing::new(String::new());
    for word in phrase.split_whitespace() {
        if !normalized.is_empty() {
            normalized.push(' ');
        }
        let start = normalized.len();
        normalized.push_str(word);
        // Safety justification: `split_whitespace` yields valid UTF-8 slices;
        // `start` is exactly at a char boundary; BIP39 English words contain
        // only lowercase a-z so `make_ascii_lowercase` is a no-op for already-
        // lowercase input and byte-safe for uppercase A-Z.
        unsafe {
            normalized.as_mut_vec()[start..].make_ascii_lowercase();
        }
    }
    // Enforce the word count. `parse_in_normalized` happily accepts any valid
    // BIP39 length (12/15/18/21/24), but this vault's design is specifically a
    // 24-word / 256-bit phrase (design doc §2), and both the UI copy and the
    // exported recovery sheet promise "24 words". Without this check a shorter
    // phrase would be accepted at every entry point — it could never actually
    // open a vault (it still has to unwrap `recovery_wrapped`), so this is
    // defence in depth and a much clearer error than a downstream unwrap
    // failure, not a hole being closed.
    let word_count = normalized.split_whitespace().count();
    if word_count != RECOVERY_WORD_COUNT {
        return Err(format!(
            "Invalid recovery phrase: expected {RECOVERY_WORD_COUNT} words, got {word_count}"
        ));
    }

    Mnemonic::parse_in_normalized(Language::English, normalized.as_str())
        .map_err(|e| format!("Invalid recovery phrase: {e}"))
}

/// Derive a 32-byte recovery key from a validated mnemonic.
///
/// Uses HKDF-SHA256 with:
/// - IKM  = `mnemonic.to_seed("")` (512-bit BIP39 seed, empty passphrase)
/// - salt = `None` (IKM is already uniform; HKDF Extract is identity-like)
/// - info = [`HKDF_INFO_RECOVERY`]
///
/// The result is `Zeroizing<[u8; 32]>` — it is wiped from memory on drop.
pub fn derive_recovery_key(mnemonic: &Mnemonic) -> Zeroizing<[u8; 32]> {
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    let hk = Hkdf::<Sha256>::new(None, &*seed);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(HKDF_INFO_RECOVERY, key.as_mut())
        .expect("HKDF expand: 32 bytes is always within the 255*HashLen limit");
    key
}

#[cfg(test)]
mod tests {

    /// A syntactically valid BIP39 phrase of the wrong length must be
    /// rejected. `Mnemonic::parse_in_normalized` accepts 12/15/18/21/24 words,
    /// but this vault is specifically a 24-word / 256-bit design and both the
    /// UI copy and the exported recovery sheet promise 24. Without the explicit
    /// count check this silently accepted half-entropy phrases at every entry
    /// point.
    #[test]
    fn validate_rejects_valid_bip39_phrases_of_the_wrong_length() {
        // A real, checksum-valid 12-word phrase (the canonical BIP39 test vector).
        let twelve = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        // Precondition: it really is valid BIP39 — otherwise this test would
        // pass for the wrong reason (rejected as garbage, not as wrong-length).
        assert!(
            bip39::Mnemonic::parse_in_normalized(bip39::Language::English, twelve).is_ok(),
            "fixture must be a genuinely valid 12-word BIP39 phrase"
        );

        let err = validate_recovery_mnemonic(twelve)
            .expect_err("a 12-word phrase must be rejected by this vault");
        assert!(
            err.contains("24 words") || err.contains("got 12"),
            "error must name the length problem, got: {err}"
        );
    }

    use super::*;

    // ── generate_recovery_mnemonic ───────────────────────────────────────────

    #[test]
    fn generate_returns_24_words() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let words: Vec<&str> = phrase.split_whitespace().collect();
        assert_eq!(
            words.len(),
            RECOVERY_WORD_COUNT,
            "generated phrase must have exactly {RECOVERY_WORD_COUNT} words, got {}",
            words.len()
        );
    }

    #[test]
    fn generate_words_are_from_english_wordlist() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let wordlist = Language::English.word_list();
        for word in phrase.split_whitespace() {
            assert!(
                wordlist.binary_search(&word).is_ok(),
                "word {word:?} not in English BIP39 wordlist"
            );
        }
    }

    #[test]
    fn generate_is_non_deterministic() {
        // Two consecutive calls must (almost certainly) differ.
        // With 256-bit entropy the probability of collision is 2^{-256}.
        let a = generate_recovery_mnemonic().unwrap();
        let b = generate_recovery_mnemonic().unwrap();
        assert_ne!(a, b, "consecutive generated phrases should differ");
    }

    // ── validate_recovery_mnemonic ───────────────────────────────────────────

    #[test]
    fn validate_accepts_generated_phrase() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let result = validate_recovery_mnemonic(&phrase);
        assert!(
            result.is_ok(),
            "freshly generated phrase must be valid; got: {:?}",
            result.err()
        );
    }

    #[test]
    fn validate_accepts_phrase_with_extra_whitespace() {
        // Users often paste with mixed whitespace or newlines.
        let phrase = generate_recovery_mnemonic().unwrap();
        let messy = phrase.split_whitespace().collect::<Vec<_>>().join("  \t\n");
        let result = validate_recovery_mnemonic(&messy);
        assert!(result.is_ok(), "whitespace-normalized phrase must be valid");
    }

    #[test]
    fn validate_accepts_phrase_with_mixed_case() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let upper = phrase.to_uppercase();
        let result = validate_recovery_mnemonic(&upper);
        assert!(result.is_ok(), "case-normalized phrase must be valid");
    }

    #[test]
    fn validate_lowercase_normalization_is_byte_stable() {
        // Verify that the zeroize-friendly in-place ASCII lowercase rewrite
        // produces the same Mnemonic as the canonical all-lowercase form.
        // Uses a known-valid phrase so the test is deterministic.
        let canonical = "abandon abandon abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon abandon abandon art";
        // Mixed-case + extra whitespace variant — the normalizer must produce
        // the same parsed Mnemonic regardless of input casing/spacing.
        let mixed = "  Abandon  ABANDON abandon\tAbandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon abandon abandon abandon  ART  ";
        let m_canonical =
            validate_recovery_mnemonic(canonical).expect("canonical phrase must parse");
        let m_mixed = validate_recovery_mnemonic(mixed)
            .expect("mixed-case phrase must parse after normalization");
        // Both mnemonics must derive the same seed (same phrase, same entropy).
        let seed_canonical = m_canonical.to_seed("");
        let seed_mixed = m_mixed.to_seed("");
        assert_eq!(
            seed_canonical, seed_mixed,
            "mixed-case+whitespace phrase must derive the same seed as canonical lowercase"
        );
    }

    #[test]
    fn validate_rejects_23_words() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let short: String = phrase
            .split_whitespace()
            .take(23)
            .collect::<Vec<_>>()
            .join(" ");
        let result = validate_recovery_mnemonic(&short);
        assert!(
            result.is_err(),
            "23-word phrase should be rejected (wrong checksum length)"
        );
    }

    #[test]
    fn validate_rejects_25_words() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let mut words: Vec<&str> = phrase.split_whitespace().collect();
        words.push("abandon"); // append an extra BIP39 word
        let long = words.join(" ");
        let result = validate_recovery_mnemonic(&long);
        assert!(
            result.is_err(),
            "25-word phrase should be rejected (wrong word count)"
        );
    }

    #[test]
    fn validate_rejects_garbage() {
        let result = validate_recovery_mnemonic("not a valid bip39 phrase at all");
        assert!(result.is_err(), "garbage input must be rejected");
    }

    #[test]
    fn validate_rejects_checksum_invalid_phrase() {
        // Strategy: take a valid generated phrase, then replace the LAST word
        // with another wordlist entry. The last word in BIP39 encodes the
        // checksum bits, so replacing it almost certainly invalidates the
        // checksum. We loop up to 20 candidate replacements to guarantee at
        // least one mismatch (collision probability per attempt < 1/256).
        let phrase = generate_recovery_mnemonic().unwrap();
        let mut words: Vec<String> = phrase.split_whitespace().map(String::from).collect();
        let wordlist = Language::English.word_list();
        let last = words[23].clone();

        let mut rejected = false;
        for candidate in wordlist.iter().take(20) {
            if *candidate == last {
                continue;
            }
            words[23] = candidate.to_string();
            let mutated = words.join(" ");
            if validate_recovery_mnemonic(&mutated).is_err() {
                rejected = true;
                break;
            }
        }
        assert!(
            rejected,
            "at least one last-word replacement must produce a checksum-invalid phrase"
        );
    }

    // ── derive_recovery_key ──────────────────────────────────────────────────

    #[test]
    fn derive_is_deterministic() {
        let phrase = generate_recovery_mnemonic().unwrap();
        let mnemonic = validate_recovery_mnemonic(&phrase).unwrap();
        let key1 = derive_recovery_key(&mnemonic);
        let key2 = derive_recovery_key(&mnemonic);
        assert_eq!(*key1, *key2, "derive_recovery_key must be deterministic");
    }

    #[test]
    fn derive_differs_for_different_mnemonics() {
        let phrase_a = generate_recovery_mnemonic().unwrap();
        let phrase_b = generate_recovery_mnemonic().unwrap();
        // In the astronomically unlikely case they match, skip.
        if phrase_a == phrase_b {
            return;
        }
        let mnemonic_a = validate_recovery_mnemonic(&phrase_a).unwrap();
        let mnemonic_b = validate_recovery_mnemonic(&phrase_b).unwrap();
        let key_a = derive_recovery_key(&mnemonic_a);
        let key_b = derive_recovery_key(&mnemonic_b);
        assert_ne!(
            *key_a, *key_b,
            "different mnemonics must produce different recovery keys"
        );
    }

    /// Known-answer test (KAT) — pins the HKDF implementation.
    ///
    /// The expected hex was generated by running:
    /// ```
    /// let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon \
    ///               abandon abandon abandon abandon abandon abandon abandon abandon \
    ///               abandon abandon abandon abandon abandon abandon abandon art";
    /// let mnemonic = validate_recovery_mnemonic(phrase).unwrap();
    /// let key = derive_recovery_key(&mnemonic);
    /// println!("{}", hex::encode(&*key));
    /// ```
    /// then hardcoding the printed value. Any change to the HKDF info string,
    /// seed passphrase, or BIP39 implementation will break this test.
    #[test]
    fn derive_known_answer_test() {
        // "abandon" × 23 + "art" is a valid BIP39 24-word phrase.
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon abandon abandon art";
        let mnemonic = validate_recovery_mnemonic(phrase).expect("known phrase must parse");
        let key = derive_recovery_key(&mnemonic);
        let hex_key = hex::encode(&*key);
        // Expected value pinned from local run of the above snippet.
        const EXPECTED_HEX: &str =
            "3e829d455c77db928b00c65f816181be309c3341801e8a355156f205fb57c603";
        assert_eq!(
            hex_key, EXPECTED_HEX,
            "recovery key KAT failed — HKDF implementation or info string changed"
        );
    }

    /// Print the full English BIP39 wordlist so it can be embedded in the
    /// frontend TypeScript source. Run with:
    ///
    ///   cargo test -p memlore --lib utils::recovery::tests::print_bip39_wordlist -- --nocapture --ignored
    #[test]
    #[ignore]
    fn print_bip39_wordlist() {
        let words = Language::English.word_list();
        println!("// Auto-generated from the bip39 crate — do NOT edit manually.");
        println!("// Run: cargo test print_bip39_wordlist -- --nocapture --ignored");
        println!("export const BIP39_EN: Set<string> = new Set([");
        for (i, word) in words.iter().enumerate() {
            let comma = if i + 1 < words.len() { "," } else { "" };
            println!("  \"{word}\"{comma}");
        }
        println!("]);");
        println!();
        println!("export const BIP39_WORD_COUNT = {};", words.len());
    }
}
