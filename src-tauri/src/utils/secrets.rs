//! Shared secret-redaction helpers.
//!
//! Both the geocoding HTTP layer and the AI-provider HTTP layer (Phase 6 v2
//! R2) flow user-supplied API keys through `reqwest`, whose default error
//! `Display` impl renders the full request URL — including any
//! query-string-embedded secret. We funnel every error string through
//! [`redact_secret`] before returning it to a Tauri command (and therefore
//! before it can land in `~/Library/Logs/...` or a panic backtrace).
//!
//! Kept regex-free on purpose: `String::replace` is enough for an exact-
//! match scrub, and the function is allocation-cheap (one `Vec<u8>` pass).
//!
//! ## When to call this
//!
//! Anywhere a user secret might escape into a string the app does not own.
//! Specifically:
//!
//! - `Result<_, String>` returned to a Tauri command from a code path that
//!   touches the secret.
//! - Anything passed to `log::warn!` / `eprintln!` / `format!` that contains
//!   a `reqwest::Error` formed against a URL with the key in it.
//!
//! For the AI-provider stack we additionally:
//!
//! - **Never derive `Debug`** on a struct that holds the API key. Implement
//!   `Debug` manually so the field renders as `"<redacted>"`.
//! - **Never bake the key into a `format!`-built `Authorization` header.**
//!   Use `reqwest::Client::header(AUTHORIZATION, ...)` so the value lives
//!   inside `reqwest::header::HeaderValue::sensitive(true)` and never
//!   surfaces in `Debug` output.

/// Replace every occurrence of `secret` in `s` with the literal string
/// `<redacted>`. Empty `secret` is treated as a no-op (the empty string
/// matches every position in `s`, which would silently destroy the input).
///
/// The function takes ownership of `s` so the caller can chain it into a
/// `.map_err(...)` without an extra clone.
pub fn redact_secret(s: String, secret: &str) -> String {
    if secret.is_empty() {
        s
    } else {
        s.replace(secret, "<redacted>")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_secret_replaces_key_in_error_string() {
        let key = "pk.eyJSecretToken123";
        let err = format!(
            "Mapbox request failed: error sending request for url (https://api.mapbox.com/x?access_token={key})"
        );
        let scrubbed = redact_secret(err, key);
        assert!(!scrubbed.contains(key));
        assert!(scrubbed.contains("<redacted>"));
    }

    #[test]
    fn redact_secret_replaces_all_occurrences() {
        let key = "ABC";
        let scrubbed = redact_secret("foo ABC bar ABC baz".into(), key);
        assert_eq!(scrubbed, "foo <redacted> bar <redacted> baz");
    }

    #[test]
    fn redact_secret_with_empty_secret_is_noop() {
        let original = "no secret to scrub";
        let scrubbed = redact_secret(original.into(), "");
        assert_eq!(scrubbed, original);
    }

    #[test]
    fn redact_secret_handles_url_embedded_key() {
        let key = "sk-test-12345";
        let s = format!("error sending request for url (https://api.openai.com/v1/embeddings?key={key}): timeout");
        let scrubbed = redact_secret(s, key);
        assert!(!scrubbed.contains(key));
        assert!(scrubbed.contains("<redacted>"));
    }
}
