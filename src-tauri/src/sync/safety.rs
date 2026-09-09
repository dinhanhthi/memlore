//! Safety helpers shared by sync code paths and the media command layer.
//!
//! Lives here (rather than inside `engine.rs`) so non-engine callers
//! (`commands::media`) can use the same validator without circular module
//! references and without each module rolling its own slightly-different
//! copy.

/// Defense-in-depth check for peer-supplied `device_id` fields.
///
/// Accepts: ASCII alphanumeric plus `-` and `_`, length 4..=64.
///
/// Production device ids come from `db::get_or_create_device_id`, which
/// generates UUIDs (36 chars). The 4-char minimum rejects an adversarial
/// peer that tries to register a 1-3 char id to squat the LWW tiebreak
/// ordering — every legitimate id, including test ids like `"dev-a"`,
/// clears 4 characters easily. The 64-char ceiling caps memory pressure
/// from a peer that sends a multi-kilobyte string.
pub fn is_safe_device_id(s: &str) -> bool {
    s.len() >= 4
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uuid_and_short_test_ids() {
        assert!(is_safe_device_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_safe_device_id("dev-a"));
        assert!(is_safe_device_id("dev_1234"));
        assert!(is_safe_device_id("abcd"));
    }

    #[test]
    fn rejects_too_short() {
        assert!(!is_safe_device_id(""));
        assert!(!is_safe_device_id("a"));
        assert!(!is_safe_device_id("abc"));
    }

    #[test]
    fn rejects_too_long() {
        let long = "a".repeat(65);
        assert!(!is_safe_device_id(&long));
    }

    #[test]
    fn rejects_special_chars() {
        assert!(!is_safe_device_id("dev/evil"));
        assert!(!is_safe_device_id("../etc"));
        assert!(!is_safe_device_id("dev evil"));
        assert!(!is_safe_device_id("dev.a"));
        assert!(!is_safe_device_id("dévice"));
    }
}
