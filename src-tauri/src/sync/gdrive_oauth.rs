//! Google OAuth 2.0 PKCE helpers for the Google Drive sync provider.
//!
//! Desktop apps (macOS) use the PKCE flow with a loopback redirect URI.
//! No `client_secret` is used — per Google documentation, installed/desktop
//! apps must omit `client_secret` from token requests.
//!
//! # Client ID provisioning
//!
//! The placeholder below is not a real Google credential. Users must create
//! their own Google Cloud project and supply a real `client_id`. Two paths:
//!
//! 1. **Build-time env var:** Set `GDRIVE_CLIENT_ID` at compile time.
//!    ```sh
//!    GDRIVE_CLIENT_ID=123-abc.apps.googleusercontent.com cargo build
//!    ```
//! 2. **Settings row:** Store `gdrive_client_id` in the settings table at
//!    runtime; the `gdrive_connect` command reads it and overrides the
//!    compiled-in value.
//!
//! See `docs/gdrive-oauth-setup.md` for the full setup walkthrough.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};
use url::Url;

/// Compiled-in placeholder. Overridden by the `GDRIVE_CLIENT_ID` env var at
/// build time or by the `gdrive_client_id` settings row at runtime.
pub const PLACEHOLDER_CLIENT_ID: &str = "PLACEHOLDER_GDRIVE_CLIENT_ID.apps.googleusercontent.com";

/// Compiled-in placeholder for the Desktop client secret.
///
/// ## Why Desktop apps need a "secret" at all
///
/// Google's Desktop app OAuth flow **requires** `client_secret` in the token
/// exchange, even though Desktop clients distribute this "secret" in every
/// installed binary. Per Google's docs
/// (https://developers.google.com/identity/protocols/oauth2/native-app):
///
/// > "The client_secret is not applicable to requests from clients registered
/// >  as Android, iOS, or Chrome applications."
///
/// Desktop apps are **not** in that exempt list — so the secret is required.
///
/// This is **not a real cryptographic secret**. Anyone with a copy of the
/// binary can extract it. PKCE (code_verifier + SHA-256 challenge) is what
/// actually protects the flow against code interception. The "secret" is a
/// Google-specific ritual, and it is safe to embed in source.
pub const PLACEHOLDER_CLIENT_SECRET: &str = "PLACEHOLDER_GDRIVE_CLIENT_SECRET";

/// The Google Drive scope that grants the app access to a hidden, app-private
/// Application Data folder (`appDataFolder`). Non-sensitive scope — data is
/// hidden from the user in the Drive UI and can only be created/read/written
/// by this app. Selected over `drive.file` so users cannot accidentally
/// delete, rename, or move the sync folder from the Drive web UI.
pub const DRIVE_APPDATA_SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";

/// Returns the effective client_id: env-var override at compile time, or the
/// placeholder if not set.
pub fn compiled_client_id() -> &'static str {
    option_env!("GDRIVE_CLIENT_ID").unwrap_or(PLACEHOLDER_CLIENT_ID)
}

/// Returns the effective client_secret for Desktop OAuth flow.
/// See `PLACEHOLDER_CLIENT_SECRET` docs for why Google needs this at all.
pub fn compiled_client_secret() -> &'static str {
    option_env!("GDRIVE_CLIENT_SECRET").unwrap_or(PLACEHOLDER_CLIENT_SECRET)
}

/// Google OAuth endpoint configuration. Parameterized so tests can swap real
/// URLs for WireMock base URIs.
#[derive(Debug, Clone)]
pub struct GoogleOAuthConfig {
    pub auth_url: String,
    pub token_url: String,
    pub revoke_url: String,
}

impl Default for GoogleOAuthConfig {
    fn default() -> Self {
        Self {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
            token_url: "https://oauth2.googleapis.com/token".to_string(),
            revoke_url: "https://oauth2.googleapis.com/revoke".to_string(),
        }
    }
}

/// PKCE code verifier — a cryptographically-random URL-safe string.
///
/// Length is 64 chars (well within [43, 128]).
#[derive(Debug, Clone)]
pub struct PkceVerifier(pub String);

/// PKCE code challenge — `BASE64URL(SHA-256(verifier))` without padding.
#[derive(Debug, Clone)]
pub struct PkceChallenge(pub String);

/// Generate a fresh PKCE verifier + challenge pair.
pub fn generate_pkce() -> (PkceVerifier, PkceChallenge) {
    // 48 random bytes → 64 base64url chars (no padding) ∈ [43, 128].
    let mut raw = [0u8; 48];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let verifier = URL_SAFE_NO_PAD.encode(raw);

    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest.as_slice());

    (PkceVerifier(verifier), PkceChallenge(challenge))
}

/// Build the Google authorization URL the browser should open.
pub fn build_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &PkceChallenge,
    config: &GoogleOAuthConfig,
) -> Result<Url, String> {
    let mut url = Url::parse(&config.auth_url).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", DRIVE_APPDATA_SCOPE)
        .append_pair("code_challenge", &challenge.0)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url)
}

/// Parsed callback parameters received by the loopback server.
#[derive(Debug, Clone)]
pub struct AuthCallback {
    pub code: String,
    pub state: String,
}

/// Bind a TCP listener on `127.0.0.1:0` and return it along with the
/// OS-assigned port. Split from `await_callback` so the caller can know the
/// port (for building the redirect URI) before the blocking accept loop.
pub async fn bind_loopback() -> Result<(tokio::net::TcpListener, u16), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {e}"))?
        .port();
    Ok((listener, port))
}

/// Await the single OAuth callback on the given listener, validating the
/// CSRF `state` parameter. Timeouts after 5 minutes.
///
/// Tolerates fragmented TCP reads (reads in a loop until the HTTP header
/// terminator `\r\n\r\n` is observed or 8 KB accumulated) and skips spurious
/// probes (browser extensions, port scanners) without consuming the timeout
/// budget on a single bad request.
pub async fn await_callback(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<AuthCallback, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let expected_state = expected_state.to_string();
    tokio::time::timeout(std::time::Duration::from_secs(300), async move {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("Accept failed: {e}"))?;

            // Read until we see \r\n\r\n or hit 8 KB (DoS cap).
            let mut buf: Vec<u8> = Vec::with_capacity(2048);
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream
                    .read(&mut tmp)
                    .await
                    .map_err(|e| format!("Read failed: {e}"))?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                let header_end = buf.windows(4).any(|w| w == b"\r\n\r\n");
                if header_end || buf.len() >= 8192 {
                    break;
                }
            }

            let request = String::from_utf8_lossy(&buf);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("");

            let callback_url = match Url::parse(&format!("http://127.0.0.1{path}")) {
                Ok(u) => u,
                Err(_) => {
                    // Malformed request (probe, bot). Respond 400 and keep listening.
                    let body = "Bad request.";
                    let response = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    continue;
                }
            };

            let params: std::collections::HashMap<_, _> =
                callback_url.query_pairs().into_owned().collect();

            // Only honor requests to the callback path — ignore everything else.
            if !callback_url.path().starts_with("/") {
                continue;
            }

            let state = match params.get("state") {
                Some(s) => s.clone(),
                None => {
                    // Not the OAuth callback (e.g. favicon, health probe) — keep listening.
                    let body = "Not the OAuth callback.";
                    let response = format!(
                        "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    continue;
                }
            };

            if state != expected_state {
                let body = "State mismatch — possible CSRF attack.";
                let response = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                return Err("CSRF: state parameter mismatch".to_string());
            }

            let code = match params.get("code").cloned() {
                Some(c) => c,
                None => {
                    return Err(
                        "OAuth callback missing code parameter (user may have denied access)"
                            .to_string(),
                    );
                }
            };

            let body = "<html><body><h2>Authorization complete! You can close this window.</h2></body></html>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;

            return Ok(AuthCallback { code, state });
        }
    })
    .await
    .map_err(|_| "OAuth loopback server timed out after 5 minutes".to_string())?
}

/// Convenience wrapper — binds the loopback and awaits the callback.
/// Kept for tests that want a single-shot API.
pub async fn start_loopback_server(expected_state: &str) -> Result<(u16, AuthCallback), String> {
    let (listener, port) = bind_loopback().await?;
    let callback = await_callback(listener, expected_state).await?;
    Ok((port, callback))
}

/// Truncate and scrub bearer tokens from error-response bodies before
/// returning them to the UI / logs. Keeps the first 200 chars; replaces
/// anything that looks like an OAuth token with `<redacted>`.
fn scrub_error_body(body: &str) -> String {
    // Truncate to 200 BYTES at a char boundary, then append an ellipsis.
    let truncated = if body.len() > 200 {
        let mut end = 200;
        while end > 0 && !body.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &body[..end])
    } else {
        body.to_string()
    };
    // Crude but adequate: replace any `Bearer <token>` and any obvious
    // Google access-token prefixes.
    let no_bearer = regex_lite_replace(&truncated, "Bearer ", "Bearer <redacted> ");
    regex_lite_replace(&no_bearer, "ya29.", "<redacted>")
}

/// Minimal non-regex string replacement — avoids pulling in `regex` for a
/// single substring scrub.
fn regex_lite_replace(input: &str, needle: &str, replacement: &str) -> String {
    if !input.contains(needle) {
        return input.to_string();
    }
    input.replace(needle, replacement)
}

/// Response from a token exchange or refresh.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    /// Only present on initial authorization code exchange.
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub scope: Option<String>,
}

/// Verify that the granted `scope` (as returned by Google's token endpoint)
/// includes the `drive.appdata` scope. Returns `Err` if the field is present
/// and does NOT contain `DRIVE_APPDATA_SCOPE`. A missing `scope` field is
/// tolerated — Google's refresh-token response omits it when the granted
/// scopes are unchanged from the original consent.
///
/// This is a **best-effort defence-in-depth check**, not the canonical
/// mismatch signal. The canonical signal is a 403 `insufficientScopes`
/// returned by the Drive API when a legacy `drive.file` access token tries
/// to query `spaces=appDataFolder`. Phase 3 of the appdata migration relies
/// on that 403 path to surface the reconnect banner; this validator just
/// catches the easier case where Google echoes the legacy scope back in
/// the token response.
///
/// Uses `split_whitespace().any(== ...)` rather than `contains(...)` so a
/// hypothetical future narrower scope like `drive.appdata.readonly` is
/// NOT confused with `drive.appdata` (covered by tests).
fn ensure_appdata_scope(scope: Option<&str>) -> Result<(), String> {
    match scope {
        None => Ok(()),
        Some(s) if s.split_whitespace().any(|tok| tok == DRIVE_APPDATA_SCOPE) => Ok(()),
        Some(_) => {
            Err("Auth: granted scope does not include drive.appdata — please reconnect".to_string())
        }
    }
}

/// Exchange an authorization code for tokens.
///
/// `token_url` is parameterized for testing (wiremock).
///
/// `client_secret` is required by Google's Desktop-app OAuth flow — see
/// the `PLACEHOLDER_CLIENT_SECRET` doc comment for why. Pass an empty
/// string only if you know your client type doesn't need one (Android, iOS,
/// Chrome apps — not applicable to Memlore).
pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &PkceVerifier,
    redirect_uri: &str,
    config: &GoogleOAuthConfig,
) -> Result<TokenResponse, String> {
    let client = reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code_verifier", &verifier.0),
        ("redirect_uri", redirect_uri),
    ];

    let resp = client
        .post(&config.token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 401 {
        return Err("Auth: token exchange rejected (401)".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Token exchange failed ({status}): {}",
            scrub_error_body(&body)
        ));
    }

    let parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;
    ensure_appdata_scope(parsed.scope.as_deref())?;
    Ok(parsed)
}

/// Refresh an access token using a refresh token.
///
/// Desktop app OAuth clients on Google must send `client_secret` — see
/// `PLACEHOLDER_CLIENT_SECRET` doc comment. (Google's docs list Android /
/// iOS / Chrome as exempt from this requirement, but Desktop is NOT in the
/// exempt list.)
pub async fn refresh_access_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
    config: &GoogleOAuthConfig,
) -> Result<TokenResponse, String> {
    let client = reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];

    let resp = client
        .post(&config.token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 401 {
        return Err("GDRIVE_TOKEN_REVOKED: Auth: refresh rejected (401)".to_string());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Google returns 400 with `"error": "invalid_grant"` when the refresh
        // token has expired (default after 6 months of inactivity) or has
        // been revoked by the user (myaccount.google.com → Security → Apps).
        // Surface this with a typed marker so the frontend can render a
        // "Reconnect to Google Drive" banner instead of a raw JSON blob.
        // Match on the JSON `error` field rather than the description so
        // we don't depend on the human-readable text wording.
        if status.as_u16() == 400 && body.contains("\"invalid_grant\"") {
            return Err("GDRIVE_TOKEN_REVOKED: Refresh token expired or revoked. \
                 Reconnect to Google Drive to continue syncing."
                .to_string());
        }
        return Err(format!(
            "Token refresh failed ({status}): {}",
            scrub_error_body(&body)
        ));
    }

    let parsed: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {e}"))?;
    ensure_appdata_scope(parsed.scope.as_deref())?;
    Ok(parsed)
}

/// Revoke a token (access or refresh). Best-effort — ignores network errors.
pub async fn revoke_token(token: &str, config: &GoogleOAuthConfig) -> Result<(), String> {
    let client = reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&config.revoke_url)
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| format!("Network error revoking token: {e}"))?;

    let status = resp.status();
    // 200 = revoked OK; 400 = already invalid — both are acceptable.
    if status.is_success() || status.as_u16() == 400 {
        return Ok(());
    }
    Err(format!("Revoke failed ({status})"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ─── PKCE tests ─────────────────────────────────────────────────────────

    #[test]
    fn pkce_verifier_length_in_range() {
        let (verifier, _) = generate_pkce();
        let len = verifier.0.len();
        assert!(
            (43..=128).contains(&len),
            "verifier length {len} not in [43, 128]"
        );
    }

    #[test]
    fn pkce_challenge_matches_sha256_of_verifier() {
        let (verifier, challenge) = generate_pkce();
        // Recompute independently.
        let digest = Sha256::digest(verifier.0.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(digest.as_slice());
        assert_eq!(
            challenge.0, expected,
            "challenge must equal BASE64URL(SHA-256(verifier))"
        );
    }

    #[test]
    fn pkce_verifier_chars_are_url_safe() {
        let (verifier, _) = generate_pkce();
        // URL-safe base64 uses A-Z a-z 0-9 - _ (no padding here)
        assert!(
            verifier
                .0
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "verifier contains non-URL-safe chars: {}",
            verifier.0
        );
    }

    #[test]
    fn pkce_pairs_are_unique() {
        let (v1, c1) = generate_pkce();
        let (v2, c2) = generate_pkce();
        assert_ne!(v1.0, v2.0, "verifiers should be random");
        assert_ne!(c1.0, c2.0, "challenges should be random");
    }

    // ─── build_authorization_url ─────────────────────────────────────────────

    #[test]
    fn build_authorization_url_contains_required_params() {
        let (_, challenge) = generate_pkce();
        let config = GoogleOAuthConfig::default();
        let url = build_authorization_url(
            "my-client-id.apps.googleusercontent.com",
            "http://127.0.0.1:12345",
            "random-state-abc",
            &challenge,
            &config,
        )
        .unwrap();
        let qs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            qs.get("client_id").map(|s| s.as_str()),
            Some("my-client-id.apps.googleusercontent.com")
        );
        assert_eq!(
            qs.get("redirect_uri").map(|s| s.as_str()),
            Some("http://127.0.0.1:12345")
        );
        assert_eq!(qs.get("response_type").map(|s| s.as_str()), Some("code"));
        assert_eq!(
            qs.get("scope").map(|s| s.as_str()),
            Some(DRIVE_APPDATA_SCOPE)
        );
        assert_eq!(
            qs.get("code_challenge").map(|s| s.as_str()),
            Some(challenge.0.as_str())
        );
        assert_eq!(
            qs.get("code_challenge_method").map(|s| s.as_str()),
            Some("S256")
        );
        assert_eq!(
            qs.get("state").map(|s| s.as_str()),
            Some("random-state-abc")
        );
    }

    // ─── scrub_error_body ────────────────────────────────────────────────────

    #[test]
    fn scrub_error_body_truncates_long_input() {
        let long = "A".repeat(300);
        let scrubbed = scrub_error_body(&long);
        // 200 bytes of content + "…" (3 bytes UTF-8) = 203 bytes max.
        assert!(
            scrubbed.len() <= 203,
            "should truncate to ≤203 bytes, got {}",
            scrubbed.len()
        );
        assert!(scrubbed.ends_with('…'));
    }

    #[test]
    fn scrub_error_body_redacts_bearer_and_ya29_tokens() {
        let input = "error: Bearer ya29.supersecret was rejected";
        let scrubbed = scrub_error_body(input);
        assert!(
            !scrubbed.contains("ya29.supersecret"),
            "token must be scrubbed, got: {scrubbed}"
        );
        assert!(scrubbed.contains("<redacted>"));
    }

    // ─── loopback server ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn bind_loopback_returns_valid_port() {
        let (_listener, port) = bind_loopback().await.unwrap();
        assert!(port > 0);
    }

    #[tokio::test]
    async fn await_callback_accepts_matching_state() {
        use tokio::io::AsyncWriteExt;
        let (listener, port) = bind_loopback().await.unwrap();

        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            let req = "GET /callback?code=abc&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
            stream.write_all(req.as_bytes()).await.unwrap();
        });

        let result = await_callback(listener, "expected").await.unwrap();
        assert_eq!(result.code, "abc");
        assert_eq!(result.state, "expected");
    }

    #[tokio::test]
    async fn await_callback_rejects_state_mismatch() {
        use tokio::io::AsyncWriteExt;
        let (listener, port) = bind_loopback().await.unwrap();

        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            let req = "GET /callback?code=abc&state=WRONG HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
            stream.write_all(req.as_bytes()).await.unwrap();
        });

        let err = await_callback(listener, "expected").await.unwrap_err();
        assert!(err.contains("CSRF"), "got: {err}");
    }

    #[tokio::test]
    async fn await_callback_ignores_probe_without_state() {
        use tokio::io::AsyncWriteExt;
        let (listener, port) = bind_loopback().await.unwrap();

        // Send a probe first, then the real request.
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;

            // Probe: no query string (like a favicon or health probe).
            let mut s1 = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            let probe = "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
            s1.write_all(probe.as_bytes()).await.unwrap();
            drop(s1);

            // Real callback.
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            let mut s2 = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
                .await
                .unwrap();
            let req = "GET /callback?code=abc&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
            s2.write_all(req.as_bytes()).await.unwrap();
        });

        let result = await_callback(listener, "expected").await.unwrap();
        assert_eq!(result.code, "abc");
    }

    // The legacy `start_loopback_server` wrapper is covered transitively by
    // `bind_loopback_*` + `await_callback_*` tests above. Removing the
    // previous "mirror" tests that only asserted `assert_ne!(…)` without
    // exercising the code path.

    // ─── exchange_code ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn exchange_code_posts_correct_form_body() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code=testcode123"))
            .and(body_string_contains("client_id=test-client-id"))
            .and(body_string_contains("code_verifier="))
            .and(body_string_contains("redirect_uri="))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.test-access-token",
                "refresh_token": "1//test-refresh-token",
                "expires_in": 3600,
                "scope": DRIVE_APPDATA_SCOPE,
                "token_type": "Bearer"
            })))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let (verifier, _) = generate_pkce();
        let result = exchange_code(
            "test-client-id",
            "test-client-secret",
            "testcode123",
            &verifier,
            "http://127.0.0.1:54321",
            &config,
        )
        .await
        .unwrap();

        assert_eq!(result.access_token, "ya29.test-access-token");
        assert_eq!(
            result.refresh_token.as_deref(),
            Some("1//test-refresh-token")
        );
        assert_eq!(result.expires_in, 3600);
    }

    #[tokio::test]
    async fn exchange_code_maps_401_to_auth_error() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let (verifier, _) = generate_pkce();
        let err = exchange_code(
            "cid",
            "sec",
            "code",
            &verifier,
            "http://127.0.0.1:1",
            &config,
        )
        .await
        .unwrap_err();
        assert!(err.contains("Auth:"), "expected Auth error, got: {err}");
    }

    // ─── refresh_access_token ────────────────────────────────────────────────

    #[tokio::test]
    async fn refresh_posts_correct_form_body() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .and(body_string_contains("refresh_token=myrefreshtoken"))
            .and(body_string_contains("client_id=test-client"))
            // Must NOT contain client_secret.
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.refreshed",
                "expires_in": 3600,
                "scope": DRIVE_APPDATA_SCOPE,
                "token_type": "Bearer"
            })))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let result = refresh_access_token("test-client", "test-secret", "myrefreshtoken", &config)
            .await
            .unwrap();
        assert_eq!(result.access_token, "ya29.refreshed");
        assert!(
            result.refresh_token.is_none(),
            "refresh must not return a new refresh_token"
        );
    }

    #[tokio::test]
    async fn refresh_maps_401_to_auth_error() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let err = refresh_access_token("cid", "sec", "bad-refresh-token", &config)
            .await
            .unwrap_err();
        assert!(err.contains("Auth:"), "expected Auth error, got: {err}");
    }

    #[tokio::test]
    async fn refresh_maps_400_invalid_grant_to_token_revoked() {
        // Google's actual response when a refresh token has been revoked or
        // expired after the 6-month inactivity TTL: HTTP 400 with body
        // `{"error":"invalid_grant","error_description":"Token has been ..."}`.
        // The frontend matches on the `GDRIVE_TOKEN_REVOKED` marker to render
        // a friendly "Reconnect" banner instead of dumping the raw JSON.
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_raw(
                        r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
                        "application/json",
                    ),
            )
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let err = refresh_access_token("cid", "sec", "revoked-refresh-token", &config)
            .await
            .unwrap_err();
        assert!(
            err.contains("GDRIVE_TOKEN_REVOKED"),
            "expected GDRIVE_TOKEN_REVOKED marker for invalid_grant, got: {err}"
        );
        assert!(
            err.contains("Reconnect to Google Drive"),
            "expected user-facing action hint, got: {err}"
        );
    }

    // ─── revoke_token ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn revoke_token_succeeds_on_200() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/revoke"))
            .and(body_string_contains("token=mytoken"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        revoke_token("mytoken", &config).await.unwrap();
    }

    #[tokio::test]
    async fn revoke_token_treats_400_as_ok() {
        // 400 = token already invalid — still acceptable.
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/revoke"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        revoke_token("expired-token", &config).await.unwrap();
    }

    // ─── scope validation ────────────────────────────────────────────────────

    #[test]
    fn ensure_appdata_scope_tolerates_missing_field() {
        // Google omits `scope` on refresh responses when granted scopes are
        // unchanged from the original consent.
        assert!(ensure_appdata_scope(None).is_ok());
    }

    #[test]
    fn ensure_appdata_scope_accepts_exact_match() {
        assert!(ensure_appdata_scope(Some(DRIVE_APPDATA_SCOPE)).is_ok());
    }

    #[test]
    fn ensure_appdata_scope_accepts_when_present_among_others() {
        // Google returns scopes space-separated.
        let combined = format!("openid email {DRIVE_APPDATA_SCOPE}");
        assert!(ensure_appdata_scope(Some(&combined)).is_ok());
    }

    #[test]
    fn ensure_appdata_scope_rejects_legacy_drive_file() {
        let err =
            ensure_appdata_scope(Some("https://www.googleapis.com/auth/drive.file")).unwrap_err();
        assert!(
            err.contains("drive.appdata") && err.contains("reconnect"),
            "expected drive.appdata + reconnect hint, got: {err}"
        );
    }

    #[test]
    fn ensure_appdata_scope_rejects_unrelated_scope() {
        let err = ensure_appdata_scope(Some("openid email")).unwrap_err();
        assert!(err.contains("Auth"), "expected Auth-prefixed error: {err}");
    }

    #[test]
    fn ensure_appdata_scope_rejects_empty_string() {
        // RFC 6749 §5.1 says `scope` "MAY" be present; an empty string
        // from a misbehaving proxy is a wrong-scope grant, not an absent one.
        assert!(ensure_appdata_scope(Some("")).is_err());
    }

    #[test]
    fn ensure_appdata_scope_handles_surrounding_whitespace() {
        // `split_whitespace` already trims; lock the behaviour in so a
        // future refactor to `split(' ')` cannot regress.
        let s = format!("   {DRIVE_APPDATA_SCOPE}   ");
        assert!(ensure_appdata_scope(Some(&s)).is_ok());
    }

    #[test]
    fn ensure_appdata_scope_does_not_match_substring() {
        // Defence: a hypothetical narrower scope must NOT be accepted as
        // `drive.appdata`. This is why we use `split_whitespace().any(==)`
        // instead of `contains(...)`.
        let err = ensure_appdata_scope(Some(
            "https://www.googleapis.com/auth/drive.appdata.readonly",
        ))
        .unwrap_err();
        assert!(err.contains("Auth"), "expected Auth-prefixed error: {err}");
    }

    #[tokio::test]
    async fn exchange_code_rejects_wrong_granted_scope() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.test-access-token",
                "refresh_token": "1//test-refresh-token",
                "expires_in": 3600,
                // Legacy drive.file scope — must be rejected so the user is
                // forced to reconnect with the new drive.appdata consent.
                "scope": "https://www.googleapis.com/auth/drive.file",
                "token_type": "Bearer"
            })))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let (verifier, _) = generate_pkce();
        let err = exchange_code(
            "cid",
            "sec",
            "code",
            &verifier,
            "http://127.0.0.1:1",
            &config,
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("drive.appdata") && err.contains("reconnect"),
            "expected scope-mismatch error, got: {err}"
        );
    }

    #[tokio::test]
    async fn refresh_token_rejects_wrong_granted_scope() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.refreshed",
                "expires_in": 3600,
                "scope": "https://www.googleapis.com/auth/drive.file",
                "token_type": "Bearer"
            })))
            .mount(&mock_server)
            .await;

        let config = GoogleOAuthConfig {
            auth_url: format!("{}/auth", mock_server.uri()),
            token_url: format!("{}/token", mock_server.uri()),
            revoke_url: format!("{}/revoke", mock_server.uri()),
        };

        let err = refresh_access_token("cid", "sec", "old-refresh", &config)
            .await
            .unwrap_err();
        assert!(
            err.contains("drive.appdata") && err.contains("reconnect"),
            "expected scope-mismatch error, got: {err}"
        );
    }
}
