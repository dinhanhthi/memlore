//! Google Drive-backed `SyncProvider` implementation.
//!
//! Uses the Google Drive REST API v3 with PKCE OAuth tokens managed by
//! `gdrive_oauth`. All HTTP calls go through a `reqwest::Client` built with
//! `redirect::Policy::none()` (SSRF protection).
//!
//! # Testability
//!
//! Both `api_base` and `upload_base` are parameterized so unit tests can
//! substitute a WireMock server URI instead of hitting real Google APIs.

use async_trait::async_trait;
use zeroize::Zeroizing;

use super::keyring_v2::io::{
    is_recovery_authority_path, preserve_during_cloud_cleanup, verify_cleanup_preserved_control,
};
use super::provider::{ConditionalRead, FileKind, SyncError, SyncProvider};

/// The literal `"appDataFolder"` keyword used in two roles by Google Drive:
/// 1. As the value of the `spaces=` query parameter on `files.list` (selects
///    the hidden Application Data space instead of `drive`).
/// 2. As an alias file-ID inside `parents: [...]` and in `q=` filters
///    (`'appDataFolder' in parents`) — equivalent to how `"root"` aliased
///    My Drive in the legacy `drive.file` setup.
///
/// One const for both roles since Google uses one keyword. Matches the
/// `drive.appdata` OAuth scope (see `gdrive_oauth`).
const APPDATA_FOLDER: &str = "appDataFolder";

/// In-memory OAuth session. Access token stays in memory only — never written
/// to disk. Refresh token is `Zeroizing` to wipe bytes on drop.
///
/// `client_secret` is included for Google's Desktop-app OAuth flow, which
/// requires it on token exchange / refresh. It is NOT a cryptographic secret
/// — see `gdrive_oauth::PLACEHOLDER_CLIENT_SECRET` for the rationale.
#[derive(Debug, Clone)]
pub struct GDriveSession {
    pub access_token: String,
    pub expires_at: std::time::Instant,
    pub refresh_token: Zeroizing<String>,
    pub client_id: String,
    pub client_secret: String,
}

/// Google Drive sync provider.
///
/// * `api_base`    — base URL for Drive REST API (default: `https://www.googleapis.com`)
/// * `upload_base` — base URL for multipart / resumable uploads
/// * `token_url`   — OAuth token refresh endpoint
pub struct GDriveProvider {
    pub(crate) http: reqwest::Client,
    pub(crate) session: std::sync::Arc<tokio::sync::RwLock<GDriveSession>>,
    /// Cached Drive file ID of the `Memlore` root folder.
    pub(crate) root_folder_id: tokio::sync::RwLock<Option<String>>,
    pub(crate) api_base: String,
    pub(crate) upload_base: String,
    pub(crate) token_url: String,
    recovery_fence_enabled: std::sync::atomic::AtomicBool,
    expected_recovery_generation: std::sync::atomic::AtomicU64,
    recovery_owner_permit: std::sync::RwLock<Option<crate::sync::recovery::RecoveryOwnerPermit>>,
    /// Per-instance cache of `generation_root_for_read`'s result. Reached
    /// not only from the pull/read path (`resolve_file_id`) but also from
    /// `resolve_file_id_for_write`'s migrate-on-write existence check and
    /// `best_effort_delete_device_namespace` — any caller of
    /// `generation_root_for_read`. `None` = not yet resolved (or resolved to
    /// "no generation namespace yet"), `Some(id)` = resolved gen-root folder
    /// ID. Like its
    /// two siblings below, only the positive (`Some`) result is ever cached
    /// — never the negative. This matters more here than for the siblings:
    /// this same instance's own write path (`ensure_generation_root`, via
    /// `write_file`) can CREATE `generations/g-N` mid-cycle (e.g. right after
    /// a generation bump). If a prior read had cached the miss, a later
    /// same-cycle read/write on this instance would keep searching the flat
    /// layout only — spurious `NotFound` on the pull side, and a stale
    /// existence check on the write side that takes the create branch again
    /// (`find_or_create_folder` dedupes folders, not files → a duplicate
    /// same-name blob). Caching only `Some` costs at most one extra
    /// `find_folder("generations", …)` per distinct `device_id` per cycle
    /// (see `device_folders_for_read_cache`, which already short-circuits
    /// warm device_ids before this is reached), not per file.
    /// Uses `std::sync::RwLock` (not `tokio::sync::RwLock`, unlike
    /// `root_folder_id`): the critical section is a plain clone/insert, no
    /// `.await` inside it, so a blocking lock is fine here — same choice as
    /// `recovery_owner_permit` above. This also lets
    /// `configure_recovery_fence_authority` clear it synchronously, keeping
    /// that method (and its call sites elsewhere in the codebase) unchanged.
    generation_root_for_read_cache: std::sync::RwLock<Option<String>>,
    /// Per-instance cache of `resolve_device_folders_for_read` results, keyed
    /// by `device_id`. Only non-empty results are cached — an empty result
    /// (peer folder not found yet) is never cached so a peer folder that
    /// appears mid-cycle is still discovered on the next read.
    device_folders_for_read_cache:
        std::sync::RwLock<std::collections::HashMap<String, Vec<String>>>,
    /// Per-instance cache of the subfolder lookup inside
    /// `resolve_file_id_under_device`, keyed by `(device_folder_id,
    /// subfolder_name)`. Only `Some` results are cached, for the same reason
    /// as `device_folders_for_read_cache`.
    subfolder_cache: std::sync::RwLock<std::collections::HashMap<(String, String), String>>,
}

// ─── Retry helper for idempotent GET/list requests ───────────────────────────

/// Maximum total attempts (1 initial + N-1 retries) for read operations.
///
/// Exposed as `pub(crate)` so tests can reference the value in `.expect()` calls.
pub(crate) const RETRY_MAX_ATTEMPTS: u32 = 4;

/// Base delay in milliseconds between retries.
/// Zero under `#[cfg(test)]` so the test suite does not sleep.
#[cfg(not(test))]
const RETRY_BASE_MS: u64 = 400;
#[cfg(test)]
const RETRY_BASE_MS: u64 = 0;

/// Maximum Retry-After delay (seconds) honoured from a server header.
/// Caps server-requested delays so sync never hangs indefinitely.
const RETRY_AFTER_CAP_SECS: u64 = 10;

/// Send an idempotent (GET / list) request with capped exponential backoff.
///
/// # Contract
///
/// - `build` is called once per attempt to produce a fresh `RequestBuilder`
///   (`RequestBuilder` is consumed by `.send()`).
/// - On 429 or any 5xx AND remaining attempts: sleep then rebuild + retry.
/// - On any other status OR when all attempts are exhausted: return the
///   response as-is so the caller's existing status-classification logic
///   (e.g. `classify_list_status`) runs unchanged on the final response.
/// - Transport-level errors (`reqwest::Error`) are surfaced immediately and
///   are NOT retried.
///
/// # Safety
///
/// Only route IDEMPOTENT reads (GET, list) through this helper.
/// **Never** route POST / PATCH / PUT / DELETE — retrying a write after a
/// 5xx can create a duplicate file (the first request may have succeeded
/// server-side but returned 5xx before the client saw the response).
async fn send_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut attempts = 0u32;
    loop {
        let resp = build().send().await?;
        let status = resp.status();
        attempts += 1;

        let should_retry =
            (status.as_u16() == 429 || status.is_server_error()) && attempts < RETRY_MAX_ATTEMPTS;

        if !should_retry {
            return Ok(resp);
        }

        // Honour a Retry-After header (integer seconds) when present,
        // capped so sync never stalls for unreasonably long periods.
        let delay_ms = if let Some(val) = resp.headers().get("retry-after") {
            let secs = val
                .to_str()
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
                .min(RETRY_AFTER_CAP_SECS);
            secs * 1_000
        } else {
            // Capped exponential backoff: base * 2^(attempt-1), max 5 s.
            let exp = RETRY_BASE_MS.saturating_mul(1u64 << (attempts - 1));
            exp.min(5_000)
        };

        // Small jitter (0–99 ms) derived from subsecond wall-clock nanos to
        // spread retries from concurrent callers. Collapses to 0 when
        // RETRY_BASE_MS == 0 (test mode) so tests stay deterministic.
        let jitter_ms = if RETRY_BASE_MS == 0 {
            0
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as u64 % 100)
                .unwrap_or(0)
        };

        tokio::time::sleep(std::time::Duration::from_millis(delay_ms + jitter_ms)).await;
    }
}

/// Synthetic revision prefixes used when Drive omits HTTP `ETag`.
/// Real etags are quoted (`"…"`) or weak (`W/"…"`); these prefixes never collide.
const REV_DRIVE_VERSION_PREFIX: &str = "drive-version:";
const REV_CONTENT_SHA_PREFIX: &str = "sha256:";

fn etag_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn content_sha256_revision(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{REV_CONTENT_SHA_PREFIX}{}", hex::encode(hasher.finalize()))
}

fn is_http_etag_revision(revision: &str) -> bool {
    !revision.starts_with(REV_DRIVE_VERSION_PREFIX) && !revision.starts_with(REV_CONTENT_SHA_PREFIX)
}

impl GDriveProvider {
    /// Resolve a revision token when media `ETag` is absent.
    ///
    /// Order (strongest → weakest for HTTP conditional writes):
    /// 1. Metadata response `ETag` header (usable with `If-Match`)
    /// 2. Drive File `version` (monotonic server revision; app-level CAS)
    /// 3. `None` — caller should fall back to content sha256
    ///
    /// Drive API v3 File schema has **no** `etag` body field; `fields=etag`
    /// returns 400. Real appDataFolder responses often omit ETag headers
    /// entirely, so version/content fallbacks are required for connect.
    async fn fetch_drive_file_revision_fallback(
        &self,
        file_id: &str,
        token: &str,
        path: &str,
    ) -> Result<Option<String>, SyncError> {
        // Valid FieldMask only — never `fields=etag`.
        let url = format!(
            "{}/drive/v3/files/{}?fields=version",
            self.api_base, file_id
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if resp.status().as_u16() == 404 {
            return Err(SyncError::NotFound(path.to_string()));
        }
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive revision metadata read failed ({}): {path}",
                resp.status()
            )));
        }
        if let Some(etag) = etag_from_headers(resp.headers()) {
            return Ok(Some(etag));
        }
        #[derive(serde::Deserialize)]
        struct VersionBody {
            version: Option<String>,
        }
        let body: VersionBody = resp
            .json()
            .await
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        Ok(body
            .version
            .filter(|value| !value.is_empty())
            .map(|version| format!("{REV_DRIVE_VERSION_PREFIX}{version}")))
    }

    /// Cheap metadata-only resolution of a file's *content* revision, for the
    /// conditional-read short-circuit. Fetches
    /// `fields=modifiedTime,md5Checksum,sha256Checksum,size` (NEVER
    /// `fields=etag` — that 400s on Drive API v3) and derives a revision token
    /// WITHOUT downloading the body:
    ///
    /// 1. `sha256Checksum` (if populated) → `sha256:<hex>` — strongest signal,
    ///    matches the `content_sha256_revision` token we compute after a real
    ///    download, so a caller that cached a post-download `sha256:` revision
    ///    gets an `Unchanged` hit from this metadata precheck next time.
    /// 2. `md5Checksum` → `sha256:<md5hex>` — Drive always computes this for
    ///    binary uploads to appDataFolder, so it is the reliable fallback. The
    ///    `sha256:` prefix family means "content-hash revision"; md5 is a
    ///    content hash, so we reuse the existing prefix rather than inventing
    ///    a second one (per the Phase 2 revision-aware-read contract).
    /// 3. `None` — metadata carried no content checksum (rare). The caller
    ///    MUST then download the body and compute `content_sha256_revision`
    ///    itself, and treat the result as "cannot match a future metadata
    ///    precheck" — i.e. the cacheable token comes from the downloaded sha.
    ///
    /// Returns `Ok(None)` on a 404 → caller maps to `NotFound` upstream via
    /// `resolve_file_id`. Here we surface `NotFound` directly so the
    /// conditional-read path mirrors `read_file`'s error mapping.
    async fn fetch_drive_file_content_revision(
        &self,
        file_id: &str,
        token: &str,
        path: &str,
    ) -> Result<Option<String>, SyncError> {
        // Valid FieldMask — `sha256Checksum`, `md5Checksum`, `modifiedTime`,
        // `size` are all real File fields. NEVER add `etag` (400s).
        let url = format!(
            "{}/drive/v3/files/{}?fields=modifiedTime,md5Checksum,sha256Checksum,size",
            self.api_base, file_id
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if resp.status().as_u16() == 404 {
            return Err(SyncError::NotFound(path.to_string()));
        }
        if resp.status().as_u16() == 401 {
            return Err(SyncError::Auth(
                "Drive: 401 reading file metadata".to_string(),
            ));
        }
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive content revision metadata read failed ({}): {path}",
                resp.status()
            )));
        }
        #[derive(serde::Deserialize)]
        struct MetaBody {
            #[serde(rename = "sha256Checksum", default)]
            sha256: Option<String>,
            #[serde(rename = "md5Checksum", default)]
            md5: Option<String>,
        }
        let body: MetaBody = resp
            .json()
            .await
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        // Prefer sha256 (matches post-download content_sha256_revision token),
        // then md5 (Drive's always-computed binary checksum). Both reuse the
        // existing REV_CONTENT_SHA_PREFIX — no second prefix convention.
        Ok(body
            .sha256
            .filter(|v| !v.is_empty())
            .or_else(|| body.md5.filter(|v| !v.is_empty()))
            .map(|hex| format!("{REV_CONTENT_SHA_PREFIX}{hex}")))
    }

    /// App-level precondition when revision is not a real HTTP ETag.
    ///
    /// Returns `Ok(None)` when the precondition holds (caller may mutate).
    /// Returns `Ok(Some(Conflict|NotFound))` when it fails.
    async fn ensure_synthetic_revision_precondition(
        &self,
        file_id: &str,
        token: &str,
        path: &str,
        expected_revision: &str,
    ) -> Result<Option<crate::sync::keyring_v2::ConditionalMutationResult>, SyncError> {
        if let Some(expected_version) = expected_revision.strip_prefix(REV_DRIVE_VERSION_PREFIX) {
            let url = format!(
                "{}/drive/v3/files/{}?fields=version",
                self.api_base, file_id
            );
            let resp = self
                .http
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|error| SyncError::Network(error.to_string()))?;
            if resp.status().as_u16() == 404 {
                return Ok(Some(
                    crate::sync::keyring_v2::ConditionalMutationResult::NotFound,
                ));
            }
            if !resp.status().is_success() {
                return Err(SyncError::Network(format!(
                    "Drive version precondition read failed ({}): {path}",
                    resp.status()
                )));
            }
            #[derive(serde::Deserialize)]
            struct VersionBody {
                version: Option<String>,
            }
            let body: VersionBody = resp
                .json()
                .await
                .map_err(|error| SyncError::Serialization(error.to_string()))?;
            let current = body.version.unwrap_or_default();
            if current != expected_version {
                return Ok(Some(
                    crate::sync::keyring_v2::ConditionalMutationResult::Conflict,
                ));
            }
            return Ok(None);
        }
        if let Some(expected_hex) = expected_revision.strip_prefix(REV_CONTENT_SHA_PREFIX) {
            let url = format!("{}/drive/v3/files/{}?alt=media", self.api_base, file_id);
            let resp = self
                .http
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|error| SyncError::Network(error.to_string()))?;
            if resp.status().as_u16() == 404 {
                return Ok(Some(
                    crate::sync::keyring_v2::ConditionalMutationResult::NotFound,
                ));
            }
            if !resp.status().is_success() {
                return Err(SyncError::Network(format!(
                    "Drive content precondition read failed ({}): {path}",
                    resp.status()
                )));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|error| SyncError::Network(error.to_string()))?;
            let current = content_sha256_revision(&bytes);
            let expected = format!("{REV_CONTENT_SHA_PREFIX}{expected_hex}");
            if current != expected {
                return Ok(Some(
                    crate::sync::keyring_v2::ConditionalMutationResult::Conflict,
                ));
            }
            return Ok(None);
        }
        Ok(None)
    }

    async fn create_reserved_shared_file_and_reconcile(
        &self,
        path: &str,
        data: &[u8],
    ) -> Result<(), SyncError> {
        let parsed = parse_shared_path(path)?;
        let SharedDrivePath::MetaFile {
            ref subfolder_path,
            ref filename,
        } = parsed;
        let root_id = self
            .ensure_root_folder_id_for_read()
            .await?
            .ok_or_else(|| SyncError::NotFound("Memlore root".to_string()))?;
        let mut parent_id = root_id;
        for segment in subfolder_path {
            parent_id = self.find_or_create_folder(segment, &parent_id).await?;
        }
        let token = self.ensure_fresh_token().await?;
        let metadata = serde_json::json!({ "name": filename, "parents": [parent_id] });
        let boundary = {
            let mut raw = [0u8; 16];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
            format!("memlore_{}", hex::encode(raw))
        };
        let mut body = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n",
            metadata
        )
        .into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
        let url = format!("{}/drive/v3/files?uploadType=multipart", self.upload_base);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&token)
            .header(
                "Content-Type",
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive reserved authority create failed: {}",
                resp.status()
            )));
        }
        self.reconcile_reserved_candidates(path, &parent_id, filename, data)
            .await
    }

    async fn reconcile_reserved_candidates(
        &self,
        path: &str,
        parent_id: &str,
        filename: &str,
        expected: &[u8],
    ) -> Result<(), SyncError> {
        let token = self.ensure_fresh_token().await?;
        let q = format!(
            "name = '{}' and '{}' in parents and trashed = false",
            escape_drive_query(filename),
            escape_drive_query(parent_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id,createdTime)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let resp = send_with_retry(|| self.http.get(&url).bearer_auth(&token))
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        classify_list_status(resp.status())?;
        #[derive(serde::Deserialize)]
        struct CandidateList {
            files: Vec<Candidate>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Candidate {
            id: String,
            #[serde(default)]
            created_time: String,
        }
        let mut candidates: CandidateList = resp
            .json()
            .await
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        if candidates.files.is_empty() {
            return Err(SyncError::Auth(format!(
                "reserved authority missing after create: {path}"
            )));
        }
        candidates.files.sort_by(|left, right| {
            left.created_time
                .cmp(&right.created_time)
                .then_with(|| left.id.cmp(&right.id))
        });
        for candidate in &candidates.files {
            let url = format!(
                "{}/drive/v3/files/{}?alt=media",
                self.api_base, candidate.id
            );
            let resp = send_with_retry(|| self.http.get(&url).bearer_auth(&token))
                .await
                .map_err(|error| SyncError::Network(error.to_string()))?;
            if !resp.status().is_success() {
                return Err(SyncError::Network(format!(
                    "Drive reserved authority reconciliation read failed: {}",
                    resp.status()
                )));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|error| SyncError::Network(error.to_string()))?;
            if bytes.as_ref() != expected {
                return Err(SyncError::Auth(format!(
                    "conflicting reserved authority candidates: {path}"
                )));
            }
        }
        for loser in candidates.files.iter().skip(1) {
            self.delete_drive_object(&loser.id).await?;
        }
        Ok(())
    }

    fn configured_recovery_generation(&self) -> u64 {
        match self
            .expected_recovery_generation
            .load(std::sync::atomic::Ordering::Acquire)
        {
            u64::MAX => 0,
            generation => generation,
        }
    }

    fn generation_folder_name(&self) -> String {
        format!("g-{}", self.configured_recovery_generation())
    }

    /// Full constructor — specify every URL explicitly. Tests inject
    /// WireMock URIs here; production uses `new_live`.
    pub fn new_with_token_url(
        session: GDriveSession,
        api_base: impl Into<String>,
        upload_base: impl Into<String>,
        token_url: impl Into<String>,
    ) -> Result<Self, String> {
        let http = reqwest::ClientBuilder::new()
            .redirect(reqwest::redirect::Policy::none())
            // Bound connection setup and per-chunk body reads so a genuinely
            // stalled TCP connection surfaces as a request error long before
            // the sync engine's 120s stall guard fires — freeing the retry
            // budget instead of consuming it on a single hung call. Deliberately
            // NOT `.timeout()`: that caps total transfer time and would abort
            // legitimate large-file uploads/downloads mid-flight.
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            http,
            session: std::sync::Arc::new(tokio::sync::RwLock::new(session)),
            root_folder_id: tokio::sync::RwLock::new(None),
            api_base: api_base.into(),
            upload_base: upload_base.into(),
            token_url: token_url.into(),
            recovery_fence_enabled: std::sync::atomic::AtomicBool::new(false),
            expected_recovery_generation: std::sync::atomic::AtomicU64::new(u64::MAX),
            recovery_owner_permit: std::sync::RwLock::new(None),
            generation_root_for_read_cache: std::sync::RwLock::new(None),
            device_folders_for_read_cache: std::sync::RwLock::new(std::collections::HashMap::new()),
            subfolder_cache: std::sync::RwLock::new(std::collections::HashMap::new()),
        })
    }

    /// Backwards-compatible constructor — derives `token_url` from
    /// `api_base`. For WireMock tests, `{api_base}/token` is used; prefer
    /// `new_with_token_url` for clarity.
    pub fn new(
        session: GDriveSession,
        api_base: impl Into<String>,
        upload_base: impl Into<String>,
    ) -> Result<Self, String> {
        let api_base = api_base.into();
        let token_url = format!("{api_base}/token");
        Self::new_with_token_url(session, api_base, upload_base, token_url)
    }

    /// Constructor pointing at real Google APIs.
    pub fn new_live(session: GDriveSession) -> Result<Self, String> {
        let provider = Self::new_with_token_url(
            session,
            "https://www.googleapis.com",
            "https://www.googleapis.com/upload",
            "https://oauth2.googleapis.com/token",
        )?;
        provider
            .recovery_fence_enabled
            .store(true, std::sync::atomic::Ordering::Release);
        provider
            .expected_recovery_generation
            .store(0, std::sync::atomic::Ordering::Release);
        Ok(provider)
    }

    /// Configure the local generation and optional exact recovery-owner
    /// authority used by the mutation boundary. Test constructors keep the
    /// fence disabled unless this builder is called explicitly.
    ///
    /// Takes `self` by value and is only ever called chained directly onto
    /// a fresh constructor (`GDriveProvider::new(...)?.with_recovery_fence(...)`)
    /// — no read has had a chance to populate the folder-ID caches yet, so
    /// unlike `configure_recovery_fence_authority` there is nothing to
    /// invalidate here.
    pub fn with_recovery_fence(
        self,
        local_generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) -> Self {
        self.expected_recovery_generation
            .store(local_generation, std::sync::atomic::Ordering::Release);
        *self
            .recovery_owner_permit
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = permit;
        self.recovery_fence_enabled
            .store(true, std::sync::atomic::Ordering::Release);
        self
    }

    /// Re-stamp the expected generation / owner permit on a LIVE instance
    /// (e.g. `gdrive_complete_connect`, `gdrive_wipe_cloud` bumping the
    /// generation mid-flow). Unlike `with_recovery_fence`, this instance may
    /// already have served reads under the old generation, so every
    /// folder-ID cache populated under it is now stale and must be cleared —
    /// otherwise a pre-bump cached gen-root/device-folder/subfolder id would
    /// leak into post-bump reads and writes.
    pub fn configure_recovery_fence_authority(
        &self,
        local_generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
        self.expected_recovery_generation
            .store(local_generation, std::sync::atomic::Ordering::Release);
        *self
            .recovery_owner_permit
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = permit;
        self.recovery_fence_enabled
            .store(true, std::sync::atomic::Ordering::Release);
        *self
            .generation_root_for_read_cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.device_folders_for_read_cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.subfolder_cache
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    async fn revalidate_recovery_fence_before_mutation(&self, path: &str) -> Result<(), SyncError> {
        if path == crate::sync::keyring_v2::RECOVERY_MARKER_PATH
            || path == crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH
            || !self
                .recovery_fence_enabled
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let control = crate::sync::recovery::read_sync_control(self)
            .await?
            .unwrap_or_else(|| crate::sync::sync_control::SyncControlV1::initial(0));
        let configured_generation = self
            .expected_recovery_generation
            .load(std::sync::atomic::Ordering::Acquire);
        let local_generation = if configured_generation == u64::MAX {
            control.recovery_generation
        } else {
            configured_generation
        };
        let permit = self
            .recovery_owner_permit
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        crate::sync::recovery::authorize_recovery_push(
            control.recovery_lease.as_ref(),
            control.recovery_generation,
            local_generation,
            permit.as_ref(),
        )
        .map_err(SyncError::Auth)
    }

    // ─── Token management ─────────────────────────────────────────────────────

    /// Ensure the access token is fresh. Refreshes (and updates session in
    /// place) if the token expires within 60 seconds. Returns the current
    /// access token string.
    pub async fn ensure_fresh_token(&self) -> Result<String, SyncError> {
        use crate::sync::gdrive_oauth::{refresh_access_token, GoogleOAuthConfig};

        let needs_refresh = {
            let session = self.session.read().await;
            session.expires_at <= std::time::Instant::now() + std::time::Duration::from_secs(60)
        };

        if needs_refresh {
            let (client_id, client_secret, refresh_token) = {
                let session = self.session.read().await;
                (
                    session.client_id.clone(),
                    session.client_secret.clone(),
                    session.refresh_token.clone(),
                )
            };

            let config = GoogleOAuthConfig {
                auth_url: String::new(),
                token_url: self.token_url.clone(),
                revoke_url: String::new(),
            };

            let token_resp =
                refresh_access_token(&client_id, &client_secret, &refresh_token, &config)
                    .await
                    .map_err(|e| {
                        // The OAuth helper returns a string error; distinguish
                        // the appdata-scope-mismatch case so the engine can
                        // trigger the reconnect banner instead of a generic
                        // re-auth flow.
                        if e.contains("drive.appdata") {
                            SyncError::ScopeMismatch(e)
                        } else {
                            SyncError::Auth(e)
                        }
                    })?;

            let new_expires_at = std::time::Instant::now()
                + std::time::Duration::from_secs(token_resp.expires_in.saturating_sub(60));

            let mut session = self.session.write().await;
            session.access_token = token_resp.access_token.clone();
            session.expires_at = new_expires_at;

            return Ok(token_resp.access_token);
        }

        Ok(self.session.read().await.access_token.clone())
    }

    // ─── Folder helpers ──────────────────────────────────────────────────────

    /// Search for a folder by name under `parent_id`. Does NOT create it.
    /// Returns the folder's Drive file ID, or `None` if absent.
    async fn find_folder(
        &self,
        name: &str,
        parent_id: &str,
        token: &str,
    ) -> Result<Option<String>, SyncError> {
        let q = format!(
            "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and '{}' in parents and trashed = false",
            escape_drive_query(name),
            escape_drive_query(parent_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            // Distinguish transient failures (rate-limit, server error,
            // auth) from "folder genuinely absent". Returning `Ok(None)`
            // for a 429 makes callers (read_file, resolve_file_id) treat
            // a throttle as `NotFound`, which propagates to the frontend
            // as a permanent ensure-failure cached for 30s — the user
            // sees "tap to download" placeholders on first sync even
            // though the file does exist on Drive.
            if status.as_u16() == 401 {
                return Err(SyncError::Auth("Drive: 401 listing folder".to_string()));
            }
            // 403 is treated as transient (quota subclass: userRateLimitExceeded /
            // rateLimitExceeded). On all READ paths `find_canonical_root_folder`
            // runs before `find_folder` and catches `insufficientScopes` as
            // `ScopeMismatch`; on WRITE paths (`write_file` / `write_shared_file`)
            // `find_folder` is reached via `find_or_create_folder` with no prior
            // canonical-root gate on a cold cache, so a 403 here could theoretically
            // be a scope error — but mapping it to `Network` is the correct
            // fail-closed behavior (the caller sees a transient error instead of
            // silently succeeding or misrouting). No body parsing needed.
            if status.as_u16() == 403 || status.as_u16() == 429 || status.is_server_error() {
                return Err(SyncError::Network(format!(
                    "Drive list folder failed: {status}"
                )));
            }
            return Ok(None);
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        #[derive(serde::Deserialize)]
        struct Fi {
            id: String,
        }
        let list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        Ok(list.files.into_iter().next().map(|f| f.id))
    }

    /// Find a folder by name under `parent_id`, or create it if absent.
    async fn find_or_create_folder(
        &self,
        name: &str,
        parent_id: &str,
    ) -> Result<String, SyncError> {
        let token = self.ensure_fresh_token().await?;

        if let Some(id) = self.find_folder(name, parent_id, &token).await? {
            return Ok(id);
        }

        // Create folder.
        self.revalidate_recovery_fence_before_mutation("__create_folder__")
            .await?;
        let body = serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id]
        });
        let url = format!("{}/drive/v3/files", self.api_base);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SyncError::Network(format!(
                "Drive create folder failed ({status}): {text}"
            )));
        }

        #[derive(serde::Deserialize)]
        struct Created {
            id: String,
        }
        let created: Created = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        Ok(created.id)
    }

    async fn generation_root_for_read(
        &self,
        root_id: &str,
        token: &str,
    ) -> Result<Option<String>, SyncError> {
        if !self
            .recovery_fence_enabled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(Some(root_id.to_string()));
        }
        let cached = self
            .generation_root_for_read_cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(cached) = cached {
            return Ok(Some(cached));
        }
        // Never cache the miss (see field doc comment) — this instance's own
        // write path can create `generations/g-N` mid-cycle, and a cached
        // `None` here would stick around after that happens.
        let Some(generations_id) = self.find_folder("generations", root_id, token).await? else {
            return Ok(None);
        };
        let result = self
            .find_folder(&self.generation_folder_name(), &generations_id, token)
            .await?;
        if let Some(ref id) = result {
            *self
                .generation_root_for_read_cache
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id.clone());
        }
        Ok(result)
    }

    /// Parent folder used for **writes** / folder creation under the recovery
    /// fence. Always the generation namespace when fencing is enabled
    /// (migrate-on-write). Does not fall back to the legacy flat layout.
    async fn ensure_generation_root(&self, root_id: &str) -> Result<String, SyncError> {
        if !self
            .recovery_fence_enabled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(root_id.to_string());
        }
        let generations_id = self.find_or_create_folder("generations", root_id).await?;
        self.find_or_create_folder(&self.generation_folder_name(), &generations_id)
            .await
    }

    /// Device folder IDs to search for **reads**, gen first then legacy flat.
    ///
    /// Returns zero, one, or two folder IDs:
    /// - gen device folder first when `generations/g-N/<device>` exists
    /// - flat `Memlore/<device>` second when a true gen namespace is active
    ///   (even if the gen device folder already exists — possibly empty)
    ///
    /// File-level dual-read uses this list so an empty gen device slot created
    /// by [`Self::ensure_folder_structure`] cannot hide still-flat payload.
    /// Writes still go through [`Self::ensure_generation_root`] (migrate-on-write).
    async fn resolve_device_folders_for_read(
        &self,
        device_id: &str,
        root_id: &str,
        token: &str,
    ) -> Result<Vec<String>, SyncError> {
        let cached = self
            .device_folders_for_read_cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(device_id)
            .cloned();
        if let Some(cached) = cached {
            return Ok(cached);
        }
        let mut folders = Vec::with_capacity(2);
        match self.generation_root_for_read(root_id, token).await? {
            Some(generation_root_id) => {
                if let Some(id) = self
                    .find_folder(device_id, &generation_root_id, token)
                    .await?
                {
                    folders.push(id);
                }
                // True generation namespace (not fence-off identity with root):
                // always include flat device folder when present so empty/partial
                // gen slots do not shadow legacy files.
                if generation_root_id != root_id {
                    if let Some(id) = self.find_folder(device_id, root_id, token).await? {
                        if !folders.iter().any(|existing| existing == &id) {
                            folders.push(id);
                        }
                    }
                }
            }
            // No generations/g-N folder at all — legacy flat layout only.
            None => {
                if let Some(id) = self.find_folder(device_id, root_id, token).await? {
                    folders.push(id);
                }
            }
        }
        // Only cache non-empty results: a peer folder that shows up mid-cycle
        // (e.g. another device's first sync) must still be found on the very
        // next read rather than being shadowed by a cached empty miss.
        if !folders.is_empty() {
            self.device_folders_for_read_cache
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(device_id.to_string(), folders.clone());
        }
        Ok(folders)
    }

    /// Resolve a single file under one device folder (optional kind subfolder).
    async fn resolve_file_id_under_device(
        &self,
        device_folder_id: &str,
        parsed: &DrivePath<'_>,
        token: &str,
    ) -> Result<Option<String>, SyncError> {
        let parent_id = match parsed.subfolder {
            None => device_folder_id.to_string(),
            Some(sub) => {
                let cache_key = (device_folder_id.to_string(), sub.to_string());
                let cached = self
                    .subfolder_cache
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .get(&cache_key)
                    .cloned();
                match cached {
                    Some(id) => id,
                    None => match self.find_folder(sub, device_folder_id, token).await? {
                        Some(id) => {
                            // Only `Some` is cached — a subfolder created
                            // mid-cycle is still found on the next read.
                            self.subfolder_cache
                                .write()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .insert(cache_key, id.clone());
                            id
                        }
                        None => return Ok(None),
                    },
                }
            }
        };

        let q = format!(
            "name = '{}' and '{}' in parents and trashed = false",
            escape_drive_query(parsed.filename),
            escape_drive_query(&parent_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id,name)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            // Same rationale as `find_folder`: do not collapse transient
            // failures into "file not found".
            if status.as_u16() == 401 {
                return Err(SyncError::Auth("Drive: 401 resolving file id".to_string()));
            }
            if status.as_u16() == 403 || status.as_u16() == 429 || status.is_server_error() {
                return Err(SyncError::Network(format!(
                    "Drive list file failed: {status}"
                )));
            }
            return Ok(None);
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        #[derive(serde::Deserialize)]
        struct Fi {
            id: String,
        }
        let list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        Ok(list.files.into_iter().next().map(|f| f.id))
    }

    /// List non-folder file basenames under a Drive parent folder.
    async fn list_file_basenames_in_parent(
        &self,
        parent_id: &str,
        token: &str,
    ) -> Result<Vec<String>, SyncError> {
        let q = format!(
            "'{}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
            escape_drive_query(parent_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id,name)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        // Fail-closed: only a 2xx proceeds; 401→Auth, everything else→Network.
        classify_list_status(resp.status())?;
        #[derive(serde::Deserialize)]
        struct Fi {
            name: String,
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        let list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        Ok(list.files.into_iter().map(|f| f.name).collect())
    }

    /// List non-folder file basenames under `{device_folder}/{subfolder}/`.
    /// Missing subfolder → empty list (not an error).
    async fn list_basenames_under_device_subfolder(
        &self,
        device_folder_id: &str,
        subfolder: &str,
        token: &str,
    ) -> Result<Vec<String>, SyncError> {
        let subfolder_id = match self.find_folder(subfolder, device_folder_id, token).await? {
            Some(id) => id,
            None => return Ok(vec![]),
        };
        self.list_file_basenames_in_parent(&subfolder_id, token)
            .await
    }

    /// Device folder under the **write** namespace only (no flat dual-read).
    ///
    /// Returns `None` when the write root or device folder is missing (e.g.
    /// fence on but `generations/g-N` not created yet). Callers that need
    /// existence-for-write or DeviceRoot prune must not fall back to flat.
    async fn resolve_device_folder_for_write(
        &self,
        device_id: &str,
        root_id: &str,
        token: &str,
    ) -> Result<Option<String>, SyncError> {
        let Some(write_root_id) = self.generation_root_for_read(root_id, token).await? else {
            // Fence on but generations/g-N not created yet → nothing to update.
            return Ok(None);
        };
        self.find_folder(device_id, &write_root_id, token).await
    }

    /// Existence check under the **write** namespace only (no flat dual-read).
    ///
    /// Migrate-on-write must never PATCH a legacy flat file when the recovery
    /// fence is on: miss under gen → create under gen.
    async fn resolve_file_id_for_write(
        &self,
        parsed: &DrivePath<'_>,
        root_id: &str,
        token: &str,
    ) -> Result<Option<String>, SyncError> {
        let Some(device_folder_id) = self
            .resolve_device_folder_for_write(parsed.device_id, root_id, token)
            .await?
        else {
            return Ok(None);
        };
        self.resolve_file_id_under_device(&device_folder_id, parsed, token)
            .await
    }

    /// List safe device-folder names under a Drive parent, excluding reserved
    /// root names (`.meta`, `generations`).
    async fn list_device_names_under(
        &self,
        parent_id: &str,
        token: &str,
    ) -> Result<Vec<String>, SyncError> {
        let q = format!(
            "mimeType = 'application/vnd.google-apps.folder' and '{}' in parents and trashed = false",
            escape_drive_query(parent_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id,name)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(SyncError::Auth("Drive: 401 listing devices".to_string()));
        }
        if !status.is_success() {
            return Err(SyncError::Network(format!(
                "Drive list_devices failed: {status}"
            )));
        }

        #[derive(serde::Deserialize)]
        struct Fi {
            name: String,
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        let list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;

        Ok(list
            .files
            .into_iter()
            .map(|f| f.name)
            .filter(|n| is_payload_device_folder_name(n))
            .collect())
    }

    /// Ensure only the stable Memlore wrapper exists. This deliberately does
    /// not create a device or generation namespace; connect must establish and
    /// validate `control.json` first.
    pub async fn ensure_root_folder_only(&self) -> Result<(String, bool), SyncError> {
        let token = self.ensure_fresh_token().await?;
        if let Some(id) = self.find_canonical_root_folder(&token).await? {
            *self.root_folder_id.write().await = Some(id.clone());
            return Ok((id, false));
        }
        let created_id = self
            .create_folder("Memlore", APPDATA_FOLDER, &token)
            .await?;
        let canonical = self
            .find_canonical_root_folder(&token)
            .await?
            .unwrap_or(created_id);
        *self.root_folder_id.write().await = Some(canonical.clone());
        Ok((canonical, true))
    }

    async fn list_direct_children(
        &self,
        parent_id: &str,
    ) -> Result<Vec<(String, String, bool)>, SyncError> {
        let token = self.ensure_fresh_token().await?;
        let q = format!(
            "'{}' in parents and trashed = false",
            escape_drive_query(parent_id)
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id,name,mimeType)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let resp = send_with_retry(|| self.http.get(&url).bearer_auth(&token))
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        classify_list_status(resp.status())?;
        #[derive(serde::Deserialize)]
        struct FileList {
            files: Vec<DriveChild>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DriveChild {
            id: String,
            name: String,
            mime_type: String,
        }
        let list: FileList = resp
            .json()
            .await
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        Ok(list
            .files
            .into_iter()
            .map(|child| {
                (
                    child.id,
                    child.name,
                    child.mime_type == "application/vnd.google-apps.folder",
                )
            })
            .collect())
    }

    pub async fn root_is_empty(&self, root_id: &str) -> Result<bool, SyncError> {
        Ok(self.list_direct_children(root_id).await?.is_empty())
    }

    async fn delete_drive_object(&self, file_id: &str) -> Result<(), SyncError> {
        let token = self.ensure_fresh_token().await?;
        let url = format!("{}/drive/v3/files/{file_id}", self.api_base);
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if resp.status().is_success() || resp.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(SyncError::Network(format!(
                "Drive cleanup delete failed: {}",
                resp.status()
            )))
        }
    }

    /// Revalidate the recovery fence and confirm `control.json` is still the
    /// same authority snapshot taken at cleanup start. Called before every
    /// delete batch so a peer lease / generation bump mid-flight fails closed
    /// instead of half-wiping the vault under a new recovery fence.
    async fn ensure_cleanup_authority_unchanged(
        &self,
        control_before: &crate::sync::sync_control::SyncControlV1,
    ) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation("__clear_cloud_payload__")
            .await?;
        let current = crate::sync::recovery::read_sync_control(self)
            .await?
            .ok_or_else(|| {
                SyncError::Auth("control.json disappeared during cleanup".to_string())
            })?;
        verify_cleanup_preserved_control(control_before, &current)
    }

    /// Delete all journal payload and keyring artifacts while preserving the
    /// stable root and `control.json` recovery-generation authority.
    ///
    /// Revalidates recovery authority **before each delete** so a peer that
    /// acquires a recovery lease mid-flight cannot race a half-wiped cloud.
    /// Fail closed if control or lease changes; no resume path is invented here
    /// (Phase 2 owns full recovery rebuild).
    pub async fn clear_cloud_preserving_control(&self) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation("__clear_cloud_payload__")
            .await?;
        let control_before = crate::sync::recovery::read_sync_control(self)
            .await?
            .ok_or_else(|| SyncError::Auth("cloud cleanup requires control.json".to_string()))?;
        let root_id = self
            .ensure_root_folder_id_for_read()
            .await?
            .ok_or_else(|| SyncError::NotFound("Memlore root".to_string()))?;

        for (id, name, is_folder) in self.list_direct_children(&root_id).await? {
            self.ensure_cleanup_authority_unchanged(&control_before)
                .await?;
            if !preserve_during_cloud_cleanup("root", &name) {
                self.delete_drive_object(&id).await?;
                continue;
            }
            if !is_folder {
                return Err(SyncError::Auth(
                    "reserved .meta path is not a folder".to_string(),
                ));
            }
            for (meta_id, meta_name, _) in self.list_direct_children(&id).await? {
                if !preserve_during_cloud_cleanup(".meta", &meta_name) {
                    self.ensure_cleanup_authority_unchanged(&control_before)
                        .await?;
                    self.delete_drive_object(&meta_id).await?;
                }
            }
        }

        let control_after = crate::sync::recovery::read_sync_control(self)
            .await?
            .ok_or_else(|| {
                SyncError::Auth("control.json disappeared during cleanup".to_string())
            })?;
        verify_cleanup_preserved_control(&control_before, &control_after)
    }

    /// Best-effort delete `generations/g-N/<device_id>/` after a failed connect
    /// that may have partially created the device namespace. Revalidates the
    /// recovery fence before mutating. Missing folders are success (idempotent).
    pub async fn best_effort_delete_device_namespace(
        &self,
        device_id: &str,
    ) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation("__delete_device_namespace__")
            .await?;
        let Some(root_id) = self.ensure_root_folder_id_for_read().await? else {
            return Ok(());
        };
        let token = self.ensure_fresh_token().await?;
        let Some(generation_root_id) = self.generation_root_for_read(&root_id, &token).await?
        else {
            return Ok(());
        };
        let Some(device_folder_id) = self
            .find_folder(device_id, &generation_root_id, &token)
            .await?
        else {
            return Ok(());
        };
        // Revalidate immediately before the delete — a peer recovery may have
        // started between the find and this point.
        self.revalidate_recovery_fence_before_mutation("__delete_device_namespace__")
            .await?;
        self.delete_drive_object(&device_folder_id).await
    }

    /// Idempotently create `Memlore/{device_id}/entries/` and
    /// `Memlore/{device_id}/media/` inside the appdata space.
    ///
    /// Returns the `Memlore` wrapper-folder ID.
    ///
    /// **Duplicate-root race mitigation:** Drive allows multiple sibling
    /// folders with the same name, so two devices connecting simultaneously
    /// can both create an `Memlore` folder inside appdata. We mitigate by:
    /// (1) after creating, re-listing all `Memlore` folders directly under
    /// `appDataFolder`, (2) picking the deterministically-earliest one by
    /// `createdTime` as the canonical root. Subsequent syncs converge on
    /// the canonical folder; any duplicate folders end up unused.
    ///
    /// (The wrapper `Memlore/` folder is technically redundant inside the
    /// appdata space — no naming-collision risk with other apps — but is
    /// kept for now so the path-parsing logic and shared keyring location
    /// stay unchanged from the `drive.file` era. Removing it is a separate
    /// cleanup.)
    pub async fn ensure_folder_structure(&self, device_id: &str) -> Result<String, SyncError> {
        self.revalidate_recovery_fence_before_mutation("__ensure_folders__")
            .await?;
        let (root_folder_id, _) = self.ensure_root_folder_only().await?;
        let generation_root_id = self.ensure_generation_root(&root_folder_id).await?;

        let device_folder_id = self
            .find_or_create_folder(device_id, &generation_root_id)
            .await?;
        self.find_or_create_folder("entries", &device_folder_id)
            .await?;
        self.find_or_create_folder("media", &device_folder_id)
            .await?;

        Ok(root_folder_id)
    }

    /// Find the earliest-created `Memlore` folder directly under
    /// `appDataFolder`. Returns `None` if none exists.
    ///
    /// **Error mapping:**
    /// - **401** → `SyncError::Auth`. Without this mapping, expired OAuth
    ///   tokens on a cold provider (post-restart, first Drive call from
    ///   `ensure_root_folder_id_for_read`) would be swallowed into `Ok(None)`
    ///   and every read path would silently report "no root folder".
    /// - **403 with `insufficientScopes`** → `SyncError::ScopeMismatch`. This
    ///   is the canonical signal that the user still holds a legacy
    ///   `drive.file` access token and needs to reconnect to receive a
    ///   `drive.appdata` grant. Engine uses this to drive the migration UX.
    /// - Other non-2xx → `Ok(None)` (a 404 legitimately means "no Memlore
    ///   folder visible in this account's appdata space"); other 403 reasons
    ///   are treated as "no folder visible" too rather than misclassifying.
    async fn find_canonical_root_folder(&self, token: &str) -> Result<Option<String>, SyncError> {
        let q = "name = 'Memlore' and mimeType = 'application/vnd.google-apps.folder' and 'appDataFolder' in parents and trashed = false";
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id,createdTime)&orderBy=createdTime&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(q),
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(SyncError::Auth(
                "Drive: 401 discovering Memlore root".to_string(),
            ));
        }
        if status.as_u16() == 403 {
            // Read the body once to check for the `insufficientScopes`
            // reason. Google returns this when the token's granted scope
            // does not match the requested `spaces=appDataFolder` query —
            // the canonical signal that a legacy drive.file user must
            // reconnect. Other 403 reasons (rate-limit-exceeded, etc.)
            // degrade to `Ok(None)` to preserve historical behaviour.
            let body = resp.text().await.unwrap_or_default();
            if body.contains("insufficientScopes")
                || body.contains("insufficient_scope")
                || body.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
            {
                return Err(SyncError::ScopeMismatch(
                    "Drive: 403 insufficientScopes on appDataFolder query — please reconnect"
                        .to_string(),
                ));
            }
            return Ok(None);
        }
        // 429 + 5xx are transient — must NOT degrade to `Ok(None)` here,
        // or every downstream `resolve_file_id` / `read_file` sees a
        // missing root folder and reports `NotFound` for media that
        // genuinely exists on Drive.
        if status.as_u16() == 429 || status.is_server_error() {
            return Err(SyncError::Network(format!(
                "Drive root-folder query failed: {status}"
            )));
        }
        if !status.is_success() {
            return Ok(None);
        }
        #[derive(serde::Deserialize)]
        struct Fi {
            id: String,
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        let list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        Ok(list.files.into_iter().next().map(|f| f.id))
    }

    /// Read-path equivalent of the lazy-populate logic inlined in
    /// `write_file`: returns the cached `root_folder_id` if known, otherwise
    /// queries Drive once for the canonical `Memlore` folder, caches it,
    /// and returns it. Returns `Ok(None)` if the folder does not exist on
    /// Drive — read paths must NOT create folders.
    ///
    /// Why this exists: `make_configured_provider` reconstructs a fresh
    /// `GDriveProvider` on every on-demand `resolve_media` call (used by
    /// the editor's "Tap to download", the voice-memo modal, and the
    /// entry-list cover fetch). Without this hydration step every such
    /// read returned `NotFound`, because only `write_file` populated
    /// `root_folder_id` lazily.
    async fn ensure_root_folder_id_for_read(&self) -> Result<Option<String>, SyncError> {
        if let Some(id) = self.root_folder_id.read().await.clone() {
            return Ok(Some(id));
        }
        let token = self.ensure_fresh_token().await?;
        let discovered = self.find_canonical_root_folder(&token).await?;
        if let Some(ref id) = discovered {
            *self.root_folder_id.write().await = Some(id.clone());
        }
        Ok(discovered)
    }

    /// Unconditionally create a folder.
    async fn create_folder(
        &self,
        name: &str,
        parent_id: &str,
        token: &str,
    ) -> Result<String, SyncError> {
        self.revalidate_recovery_fence_before_mutation("__create_folder__")
            .await?;
        let body = serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id]
        });
        let url = format!("{}/drive/v3/files", self.api_base);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive create folder failed: {}",
                resp.status()
            )));
        }
        #[derive(serde::Deserialize)]
        struct Created {
            id: String,
        }
        let created: Created = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        Ok(created.id)
    }

    /// Resolve a relative path to a Drive file ID. Returns `None` if not
    /// found (does NOT create any folder). Accepts two path shapes:
    /// - `{device_id}/{filename}` — file in the device folder (e.g. `metadata.json`)
    /// - `{device_id}/{subfolder}/{filename}` — file one level deeper
    ///
    /// Path validation (including the `q=` injection defence) is handled by
    /// `parse_drive_path`.
    ///
    /// When `root_folder_id` is `None` (provider was freshly reconstructed
    /// after an app restart, e.g. inside `make_configured_provider` for an
    /// on-demand `resolve_media` call), this lazily discovers the canonical
    /// `Memlore` folder by querying Drive. The found ID is cached so the
    /// next call short-circuits. Read paths must never *create* the folder —
    /// that's the connect/write path's job.
    async fn resolve_file_id(&self, path: &str) -> Result<Option<String>, SyncError> {
        let parsed = parse_drive_path(path)?;

        let root_id = self.ensure_root_folder_id_for_read().await?;
        let root_id = match root_id {
            Some(id) => id,
            // Root folder genuinely not on Drive (user hasn't connected, or
            // the folder was deleted out-of-band) → file cannot exist.
            None => return Ok(None),
        };

        let token = self.ensure_fresh_token().await?;

        // File-level dual-read: try each device folder (gen first, then flat).
        // Gen miss (including empty gen slot) falls through to flat.
        for device_folder_id in self
            .resolve_device_folders_for_read(parsed.device_id, &root_id, &token)
            .await?
        {
            if let Some(file_id) = self
                .resolve_file_id_under_device(&device_folder_id, &parsed, &token)
                .await?
            {
                return Ok(Some(file_id));
            }
        }
        Ok(None)
    }
}

/// Escape a string literal inside a Google Drive `q=` search query.
///
/// Drive's query language delimits string literals with single quotes and
/// interprets `\` as the escape character. Any caller-supplied name or ID
/// that may contain `'` or `\` MUST be passed through here before inclusion
/// in a `q=` expression. See:
/// https://developers.google.com/workspace/drive/api/guides/search-files#query_string_syntax
fn escape_drive_query(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Validate that an identifier (device_id or file basename) contains only
/// characters that are safe both for Drive query strings and for filesystem
/// paths on other providers. This is a defence-in-depth check against
/// `q=` injection (see C2 in the security review).
fn is_safe_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Classify the HTTP status from a Drive *file-list* response (the
/// `GET /drive/v3/files?q=…` family) as either success (`Ok(())`) or a typed
/// error.
///
/// This is the **fail-closed gate** for every listing call: only a genuine
/// 2xx is allowed to continue to JSON parsing. All other statuses return `Err`
/// so that a transient failure can never be silently misread as "the folder is
/// empty" or "the file doesn't exist".
///
/// **Absence is NOT a status.** A 2xx with `"files": []` means genuinely
/// absent; callers handle that separately after this call returns `Ok(())`.
///
/// Mapping rationale:
/// - **2xx** → `Ok(())` — proceed to parse.
/// - **401** → `Auth` — expired/invalid token; signals the engine to
///   re-authenticate.
/// - **403 / 429 / 5xx** → `Network` — transient: quota, rate-limit, server
///   error. On all READ paths root-folder discovery already ran with the same
///   token, so an `insufficientScopes` 403 would have been caught upstream as
///   `ScopeMismatch`. On WRITE paths (`write_file` / `write_shared_file`) there
///   is no prior canonical-root gate on a cold cache; a scope-error 403 would
///   therefore reach here, but mapping it to `Network` is correct fail-closed
///   behavior — the caller sees a transient error rather than silently succeeding.
/// - **All other non-2xx (including 404)** → `Network` — fail-closed: a 404
///   from a list endpoint is unexpected and must not be treated as "empty".
fn classify_list_status(status: reqwest::StatusCode) -> Result<(), SyncError> {
    if status.is_success() {
        return Ok(());
    }
    if status.as_u16() == 401 {
        return Err(SyncError::Auth("Drive: 401 on file-list query".to_string()));
    }
    Err(SyncError::Network(format!(
        "Drive file-list query failed: {status}"
    )))
}

/// Parsed relative path `{device_id}/[{subfolder}/]{filename}`. Produced by
/// `parse_drive_path` so `resolve_file_id` / `write_file` / `read_file` /
/// `delete_file` share one vetted parser. Two shapes are accepted:
///
/// - **2 parts** (`{device_id}/{filename}`) — file lives directly under the
///   device folder, e.g. `metadata.json`.
/// - **3 parts** (`{device_id}/{subfolder}/{filename}`) — file lives one
///   level deeper (`entries`, `media`, …). The middle component is stored
///   in `subfolder` so `write_file` can create it on demand; nothing is
///   hardcoded to "entries".
#[derive(Debug, PartialEq, Eq)]
struct DrivePath<'a> {
    device_id: &'a str,
    subfolder: Option<&'a str>,
    filename: &'a str,
}

/// Parse + validate a relative sync path. Returns `SyncError::Io` for any
/// shape the protocol does not emit (single-component paths, nested trees
/// deeper than one subfolder, empty components, or components that would
/// break `q=` injection protection — see `is_safe_identifier`).
fn parse_drive_path(path: &str) -> Result<DrivePath<'_>, SyncError> {
    let parts: Vec<&str> = path.split('/').collect();
    let parsed = match parts.as_slice() {
        [device_id, filename] => DrivePath {
            device_id,
            subfolder: None,
            filename,
        },
        [device_id, subfolder, filename] => DrivePath {
            device_id,
            subfolder: Some(subfolder),
            filename,
        },
        _ => return Err(SyncError::Io(format!("Invalid path: {path}"))),
    };
    // Validate every component with the same defence-in-depth check.
    // Includes subfolder — even though today's values come from engine
    // format strings (`entries`, future `media`), the guard must not
    // regress if those ever become caller-controlled.
    let any_unsafe = [parsed.device_id, parsed.filename]
        .into_iter()
        .chain(parsed.subfolder)
        .any(|c| !is_safe_identifier(c));
    if any_unsafe {
        return Err(SyncError::Io(format!(
            "Invalid path component in {path} — only [A-Za-z0-9._-] allowed"
        )));
    }
    Ok(parsed)
}

/// Minimal percent-encoding for Google Drive query string values.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ─── Shared path (Memlore root, not device-scoped) ─────────────────────────

/// Exact shared paths (no dynamic segment) accepted by `parse_shared_path`.
/// The allow-list is the primary defence against arbitrary file reads/writes
/// on Drive. Listing devices folder slots is allowed via a separate prefix
/// match (`SHARED_PATH_DEVICE_SLOT_PREFIX`) because slot filenames are
/// dynamic per-device UUIDs.
const SHARED_PATH_EXACT_ALLOW_LIST: &[&str] = &[
    // V1 keyring — kept readable so `wipe_v1_keyring_if_present` can probe + delete it.
    ".meta/keyring.json",
    // Persistent mode-independent recovery generation + exact-owner lease.
    ".meta/control.json",
    // Authoritative recovery coordination fence.
    ".meta/_recovery_marker.json",
    // V2 keyring meta + recovery slot + content-key list.
    ".meta/keyring/_meta.json",
    ".meta/keyring/_recovery.json",
    ".meta/keyring/_content.json",
];

/// V2 device-slot files live at `.meta/keyring/devices/<device_id>.json`.
/// Filenames are per-device UUIDs so we match by prefix + suffix instead of
/// listing every slot in the exact allow-list.
const SHARED_PATH_DEVICE_SLOT_PREFIX: &str = ".meta/keyring/devices/";
const SHARED_PATH_DEVICE_SLOT_SUFFIX: &str = ".json";

/// Directories that can be listed via `KeyringV2Io::list_files`. Only the
/// devices directory is enumerable today; future additions should be
/// explicit allow-list entries to keep the listing API tight.
const SHARED_LISTABLE_DIRS: &[&str] = &[".meta/keyring/devices"];

/// Device folder names eligible for list/read dual-path resolution. Filters
/// reserved root siblings so flat-layout dual-read never treats `generations`
/// or `.meta` as peer devices.
fn is_payload_device_folder_name(name: &str) -> bool {
    crate::sync::safety::is_safe_device_id(name) && name != "generations"
}

/// Parsed shared path anchored at the Memlore root. `subfolder_path` is the
/// list of folder name segments below the root; `filename` is the final
/// component. Drive's folder tree is flat (each folder has a parent id) so
/// callers walk the segments one at a time via `find_folder` /
/// `find_or_create_folder`.
pub(crate) enum SharedDrivePath {
    MetaFile {
        subfolder_path: Vec<String>,
        filename: String,
    },
}

/// Parse a shared path of shape `{subfolder}/.../{filename}` anchored at the
/// Memlore root (i.e. NOT inside any device folder).
///
/// Accepts:
///   - Any path in `SHARED_PATH_EXACT_ALLOW_LIST` (V1 keyring, control.json,
///     V2 `_meta.json` / `_recovery.json`).
///   - V2 device slot files matching
///     `{SHARED_PATH_DEVICE_SLOT_PREFIX}<id>{SHARED_PATH_DEVICE_SLOT_SUFFIX}`
///     where `<id>` contains no `/` (one segment).
///
/// Returns `SyncError::Io` for paths outside both forms, paths with fewer
/// than two components (no subfolder), or paths containing `..` (traversal
/// defence).
pub(crate) fn parse_shared_path(path: &str) -> Result<SharedDrivePath, SyncError> {
    if path.split('/').any(|c| c == "..") {
        return Err(SyncError::Io(format!("Path traversal rejected: {path}")));
    }

    let in_exact_allow = SHARED_PATH_EXACT_ALLOW_LIST.contains(&path);
    let in_device_slot_form = path.starts_with(SHARED_PATH_DEVICE_SLOT_PREFIX)
        && path.ends_with(SHARED_PATH_DEVICE_SLOT_SUFFIX)
        && {
            let rest = &path[SHARED_PATH_DEVICE_SLOT_PREFIX.len()..];
            let stem = &rest[..rest.len() - SHARED_PATH_DEVICE_SLOT_SUFFIX.len()];
            !stem.is_empty() && !stem.contains('/')
        };

    if !in_exact_allow && !in_device_slot_form {
        return Err(SyncError::Io(format!(
            "Shared path not in allow-list: {path}"
        )));
    }

    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 2 || parts.iter().any(|c| c.is_empty()) {
        return Err(SyncError::Io(format!(
            "Invalid shared path (must be {{subfolder}}/.../{{filename}}): {path}"
        )));
    }

    let (filename, subfolder_segments) = parts.split_last().expect("len >= 2 checked above");
    Ok(SharedDrivePath::MetaFile {
        subfolder_path: subfolder_segments.iter().map(|s| s.to_string()).collect(),
        filename: filename.to_string(),
    })
}

// ─── SyncProvider impl ───────────────────────────────────────────────────────

#[async_trait]
impl SyncProvider for GDriveProvider {
    async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
        // Same lazy hydration as `resolve_file_id` — a freshly reconstructed
        // provider (e.g. inside `make_configured_provider` after restart)
        // would otherwise report "no devices" without ever querying Drive.
        let root_id = match self.ensure_root_folder_id_for_read().await? {
            Some(id) => id,
            None => return Ok(vec![]),
        };

        let token = self.ensure_fresh_token().await?;
        // Dual-read: prefer generation namespace devices; always include flat
        // root devices when a true gen folder exists (or when gen is absent)
        // so legacy vaults stay visible after the Phase 1 cutover.
        let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        match self.generation_root_for_read(&root_id, &token).await? {
            Some(generation_root_id) => {
                for name in self
                    .list_device_names_under(&generation_root_id, &token)
                    .await?
                {
                    names.insert(name);
                }
                if generation_root_id != root_id {
                    for name in self.list_device_names_under(&root_id, &token).await? {
                        names.insert(name);
                    }
                }
            }
            None => {
                for name in self.list_device_names_under(&root_id, &token).await? {
                    names.insert(name);
                }
            }
        }
        Ok(names.into_iter().collect())
    }

    async fn list_files(&self, device_id: &str, kind: FileKind) -> Result<Vec<String>, SyncError> {
        // Lazy hydrate — see `list_devices` above for the rationale.
        let root_id = match self.ensure_root_folder_id_for_read().await? {
            Some(id) => id,
            None => return Ok(vec![]),
        };

        let token = self.ensure_fresh_token().await?;

        let mut by_basename: std::collections::BTreeMap<String, String> =
            std::collections::BTreeMap::new();
        match kind.subfolder_name() {
            None => {
                // DeviceRoot: write-namespace only (no flat dual-read).
                // Used by own-cloud reconcile to decide whether a surface
                // `.bin` / `metadata.json` is missing and must re-upload.
                // A legacy flat leftover must not mask a missing gen-namespace
                // file — same contract as `resolve_file_id_for_write`.
                if let Some(device_folder_id) = self
                    .resolve_device_folder_for_write(device_id, &root_id, &token)
                    .await?
                {
                    let basenames = self
                        .list_file_basenames_in_parent(&device_folder_id, &token)
                        .await?;
                    for name in basenames {
                        by_basename
                            .entry(name.clone())
                            .or_insert_with(|| format!("{device_id}/{name}"));
                    }
                }
            }
            Some(subfolder) => {
                // File-level dual-read merge: gen basenames first, then flat-only
                // names. Same basename in both → keep gen (migrate-on-write winner).
                let device_folders = self
                    .resolve_device_folders_for_read(device_id, &root_id, &token)
                    .await?;
                for device_folder_id in device_folders {
                    let basenames = self
                        .list_basenames_under_device_subfolder(&device_folder_id, subfolder, &token)
                        .await?;
                    for name in basenames {
                        by_basename
                            .entry(name.clone())
                            .or_insert_with(|| format!("{device_id}/{subfolder}/{name}"));
                    }
                }
            }
        }
        Ok(by_basename.into_values().collect())
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let file_id = self
            .resolve_file_id(path)
            .await?
            .ok_or_else(|| SyncError::NotFound(path.to_string()))?;

        let token = self.ensure_fresh_token().await?;
        let url = format!("{}/drive/v3/files/{}?alt=media", self.api_base, file_id);

        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(SyncError::Auth("Drive: 401 reading file".to_string()));
        }
        if status.as_u16() == 404 {
            return Err(SyncError::NotFound(path.to_string()));
        }
        // 429 and 5xx are transient — surface as Network so callers can
        // distinguish them from NotFound. The frontend's `ensureMediaCached`
        // negative-cache treats every failure the same (30 s lockout), but
        // a distinct error message at least makes log triage possible.
        if !status.is_success() {
            return Err(SyncError::Network(format!("Drive read failed: {status}")));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| SyncError::Network(e.to_string()))
    }

    /// Revision-aware read for Google Drive.
    ///
    /// Network-efficiency is the whole point: when the caller supplies a
    /// `known_revision`, we issue ONE cheap metadata GET
    /// (`fields=modifiedTime,md5Checksum,sha256Checksum,size` — never
    /// `fields=etag`, which 400s) and short-circuit to `Unchanged` without
    /// downloading the body. Only on a mismatch (or when `known_revision` is
    /// `None`, or when metadata yields no content checksum to compare) do we
    /// download the body via the same media-GET path as `read_file`.
    ///
    /// # Revision tokens & caching
    ///
    /// After a download we return `content_sha256_revision(bytes)` as the
    /// cacheable revision — the strongest signal, and reproducible by a future
    /// metadata precheck when Drive exposes `sha256Checksum`. When Drive only
    /// exposes `md5Checksum`, the next precheck derives an md5 token that
    /// won't match the cached sha — that's a safe cache miss (one extra
    /// download), NEVER a false `Unchanged`. Either way the None-invariant
    /// holds: a caller with `known_revision: None`, or a file whose revision
    /// we cannot resolve, ALWAYS gets the bytes back via `Changed`.
    async fn read_file_if_changed(
        &self,
        path: &str,
        known_revision: Option<&str>,
    ) -> Result<ConditionalRead, SyncError> {
        let file_id = self
            .resolve_file_id(path)
            .await?
            .ok_or_else(|| SyncError::NotFound(path.to_string()))?;

        let token = self.ensure_fresh_token().await?;

        // Cheap path: only when the caller actually has a cached revision do we
        // bother with the metadata precheck. A None known_revision skips
        // straight to the download (the None-invariant demands bytes back).
        if let Some(known) = known_revision {
            match self
                .fetch_drive_file_content_revision(&file_id, &token, path)
                .await?
            {
                Some(current) if current.as_str() == known => {
                    return Ok(ConditionalRead::Unchanged);
                }
                // Metadata had no content checksum to compare (rare), or the
                // revision differs — fall through to the body download.
                _ => {}
            }
        }

        // Download path — mirrors `read_file` exactly: media GET, retry on
        // transient errors, same status → SyncError mapping.
        let url = format!("{}/drive/v3/files/{}?alt=media", self.api_base, file_id);
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(SyncError::Auth("Drive: 401 reading file".to_string()));
        }
        if status.as_u16() == 404 {
            return Err(SyncError::NotFound(path.to_string()));
        }
        if !status.is_success() {
            return Err(SyncError::Network(format!("Drive read failed: {status}")));
        }
        let bytes = resp
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| SyncError::Network(e.to_string()))?;

        // Strongest reproducible signal: sha256 of the just-downloaded bytes.
        // Reuses REV_CONTENT_SHA_PREFIX — no second convention.
        let revision = content_sha256_revision(&bytes);
        Ok(ConditionalRead::Changed {
            bytes,
            revision: Some(revision),
        })
    }

    // Path validation (including q= injection defence) is handled by
    // `parse_drive_path`.
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let parsed = parse_drive_path(path)?;
        self.revalidate_recovery_fence_before_mutation(path).await?;

        let token = self.ensure_fresh_token().await?;

        // Existence under write namespace only (no flat dual-read). Otherwise
        // migrate-on-write would PATCH a legacy flat file when gen is empty.
        if let Some(root_for_write_check) = self.ensure_root_folder_id_for_read().await? {
            if let Some(file_id) = self
                .resolve_file_id_for_write(&parsed, &root_for_write_check, &token)
                .await?
            {
                // Update existing file in the write namespace.
                let url = format!(
                    "{}/drive/v3/files/{}?uploadType=media",
                    self.upload_base, file_id
                );
                self.revalidate_recovery_fence_before_mutation(path).await?;
                let resp = self
                    .http
                    .patch(&url)
                    .bearer_auth(&token)
                    .header("Content-Type", "application/octet-stream")
                    .body(data.to_vec())
                    .send()
                    .await
                    .map_err(|e| SyncError::Network(e.to_string()))?;
                if !resp.status().is_success() {
                    return Err(SyncError::Network(format!(
                        "Drive update failed: {}",
                        resp.status()
                    )));
                }
                return Ok(());
            }
        }

        // Create new file — ensure folder structure first.
        let root_id = {
            let lock = self.root_folder_id.read().await;
            lock.clone()
        };
        let root_id = match root_id {
            Some(id) => id,
            None => {
                let id = self
                    .find_or_create_folder("Memlore", APPDATA_FOLDER)
                    .await?;
                *self.root_folder_id.write().await = Some(id.clone());
                id
            }
        };
        let generation_root_id = self.ensure_generation_root(&root_id).await?;
        let device_folder_id = self
            .find_or_create_folder(parsed.device_id, &generation_root_id)
            .await?;
        // Resolve the target parent: the device folder itself for 2-part
        // paths, or the named subfolder one level deeper. Do not hardcode
        // "entries" — media (chunk 6) will use the same write path.
        let parent_id = match parsed.subfolder {
            None => device_folder_id,
            Some(sub) => self.find_or_create_folder(sub, &device_folder_id).await?,
        };

        // Multipart upload (metadata + bytes in one request).
        //
        // Boundary MUST be unpredictable — a static boundary would let future
        // plaintext payloads (e.g., a `metadata.json` body containing the
        // literal boundary string) corrupt the upload. Each request gets a
        // fresh 128-bit random boundary.
        let metadata = serde_json::json!({ "name": parsed.filename, "parents": [parent_id] });
        let meta_str = metadata.to_string();
        let boundary = {
            let mut raw = [0u8; 16];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
            format!("memlore_{}", hex::encode(raw))
        };
        let mut body: Vec<u8> = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta_str}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());

        let url = format!("{}/drive/v3/files?uploadType=multipart", self.upload_base);
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&token)
            .header(
                "Content-Type",
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SyncError::Network(format!(
                "Drive write failed ({status}): {text}"
            )));
        }
        Ok(())
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let parsed = parse_drive_path(path)?;

        // Root unknown / absent → nothing to delete (idempotent).
        let root_id = match self.ensure_root_folder_id_for_read().await? {
            Some(id) => id,
            None => return Ok(()),
        };

        let token = self.ensure_fresh_token().await?;

        // Dual-layout: same basename can exist under both
        // `generations/g-N/<device>/…` and legacy flat `Memlore/<device>/…`
        // after migrate-on-write. Prefer-gen dual-read would only surface one
        // file_id; deleting that alone leaves a flat (or gen) orphan that
        // list/read resurrect. Delete every match across all device folders
        // from `resolve_device_folders_for_read` (idempotent if one side is
        // already gone).
        let mut file_ids: Vec<String> = Vec::with_capacity(2);
        for device_folder_id in self
            .resolve_device_folders_for_read(parsed.device_id, &root_id, &token)
            .await?
        {
            if let Some(file_id) = self
                .resolve_file_id_under_device(&device_folder_id, &parsed, &token)
                .await?
            {
                if !file_ids.iter().any(|existing| existing == &file_id) {
                    file_ids.push(file_id);
                }
            }
        }

        if file_ids.is_empty() {
            return Ok(());
        }

        for file_id in file_ids {
            self.revalidate_recovery_fence_before_mutation(path).await?;
            let url = format!("{}/drive/v3/files/{}", self.api_base, file_id);
            let resp = self
                .http
                .delete(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| SyncError::Network(e.to_string()))?;

            let status = resp.status();
            // 204 No Content = deleted; 404 = already gone; both are Ok.
            if status.as_u16() == 204 || status.as_u16() == 404 || status.is_success() {
                continue;
            }
            return Err(SyncError::Network(format!("Drive delete failed: {status}")));
        }
        Ok(())
    }
}

// ─── Shared-file I/O (Memlore root, not device-scoped) ─────────────────────

impl GDriveProvider {
    /// Read a file at a shared path (e.g. `.meta/keyring.json`) anchored at
    /// the Memlore root folder. Returns `SyncError::NotFound` if the root
    /// folder, the subfolder, or the file itself is absent.
    ///
    /// Unlike `write_shared_file`, this does NOT auto-CREATE the root folder.
    /// It does, however, lazily DISCOVER an existing root folder on Drive via
    /// the same path `resolve_file_id` uses — so a freshly reconstructed
    /// provider can still read the shared keyring without first running
    /// `ensure_folder_structure`. If no `Memlore` folder exists on Drive
    /// at all, this returns `NotFound` (the keyring genuinely cannot exist).
    pub async fn read_shared_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let parsed = parse_shared_path(path)?;
        let SharedDrivePath::MetaFile {
            ref subfolder_path,
            ref filename,
        } = parsed;

        let root_id = self
            .ensure_root_folder_id_for_read()
            .await?
            .ok_or_else(|| {
                SyncError::NotFound(format!(
                    "Memlore root not on Drive; cannot read shared path: {path}"
                ))
            })?;

        let token = self.ensure_fresh_token().await?;

        // Walk the subfolder segments. Drive's folder tree is flat (each
        // folder has a parent id) so for `.meta/keyring/devices/...` we
        // resolve `.meta` under root, then `keyring` under `.meta`, then
        // `devices` under `keyring`. Any missing segment short-circuits to
        // NotFound so callers (e.g. `list_device_slots` on a fresh vault)
        // get a clean "no slots" result without spurious errors.
        let mut subfolder_id = root_id.clone();
        for segment in subfolder_path {
            subfolder_id = match self.find_folder(segment, &subfolder_id, &token).await? {
                Some(id) => id,
                None => return Err(SyncError::NotFound(path.to_string())),
            };
        }

        // Find the file inside the subfolder.
        let q = format!(
            "name = '{}' and '{}' in parents and trashed = false",
            escape_drive_query(filename),
            escape_drive_query(&subfolder_id),
        );
        let authority_path = path == crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH;
        let fields = if authority_path {
            "files(id,createdTime)"
        } else {
            "files(id)"
        };
        let url = format!(
            "{}/drive/v3/files?q={}&fields={fields}&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        // Two-level handling: this list query uses `classify_list_status`
        // (fail-closed: 404→Network, not NotFound) while the download GET
        // below maps 404→NotFound. The distinction is intentional — a 404
        // on a *list* endpoint is unexpected (list queries return empty
        // arrays for absent files, never 404), so it is treated as a
        // transient/misconfiguration error rather than genuine absence.
        // A genuine 429/5xx must never be collapsed into NotFound.
        classify_list_status(resp.status())?;
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fi {
            id: String,
            #[serde(default)]
            created_time: String,
        }
        let mut list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        if list.files.len() > 1 && !authority_path {
            return Err(SyncError::Auth(format!(
                "duplicate shared path is ambiguous: {path}"
            )));
        }
        list.files.sort_by(|left, right| {
            left.created_time
                .cmp(&right.created_time)
                .then_with(|| left.id.cmp(&right.id))
        });
        let file_id = list
            .files
            .into_iter()
            .next()
            .ok_or_else(|| SyncError::NotFound(path.to_string()))?
            .id;

        // Download file bytes.
        let url = format!("{}/drive/v3/files/{}?alt=media", self.api_base, file_id);
        let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if status.as_u16() == 404 {
            return Err(SyncError::NotFound(path.to_string()));
        }
        if !status.is_success() {
            return Err(SyncError::Network(format!(
                "Drive read shared failed ({status}): {path}"
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        // The keyring JSON is tiny (< 1 KB). A very large response indicates
        // corruption or a malicious payload — cap before allocating.
        const MAX_KEYRING_BYTES: usize = 8 * 1024;
        if bytes.len() > MAX_KEYRING_BYTES {
            return Err(SyncError::Io(format!(
                "Shared file response too large: {} bytes (max {MAX_KEYRING_BYTES}): {path}",
                bytes.len()
            )));
        }
        Ok(bytes.to_vec())
    }

    /// Resolve the Drive file id for a *shared* path (e.g.
    /// `.meta/keyring/devices/{uuid}.json`) anchored at the Memlore root.
    ///
    /// Mirrors `read_shared_file`'s folder-walk + file-lookup but returns the
    /// file id instead of the bytes, for callers that need to act on the file
    /// (e.g. delete). Unlike `read_shared_file`, this does NOT collapse HTTP
    /// failures into "absent": `Ok(None)` means *genuine* absence (root folder
    /// missing, a subfolder segment missing, or the file-list query returned
    /// empty). Transient/auth/server errors propagate as `Err` — following the
    /// same 401/429/5xx discipline as `resolve_file_id`. Collapsing a transient
    /// error to `None` here would let `delete_file` silently skip a slot that
    /// still exists, leaving a revoked device's slot live on the cloud.
    async fn resolve_shared_file_id(&self, path: &str) -> Result<Option<String>, SyncError> {
        let parsed = parse_shared_path(path)?;
        let SharedDrivePath::MetaFile {
            ref subfolder_path,
            ref filename,
        } = parsed;

        let root_id = match self.ensure_root_folder_id_for_read().await? {
            Some(id) => id,
            None => return Ok(None),
        };

        let token = self.ensure_fresh_token().await?;

        // Walk the subfolder chain; any missing segment ⇒ genuinely absent.
        let mut subfolder_id = root_id;
        for segment in subfolder_path {
            subfolder_id = match self.find_folder(segment, &subfolder_id, &token).await? {
                Some(id) => id,
                None => return Ok(None),
            };
        }

        // Look up the file by name inside the resolved subfolder.
        let q = format!(
            "name = '{}' and '{}' in parents and trashed = false",
            escape_drive_query(filename),
            escape_drive_query(&subfolder_id),
        );
        let authority_path = path == crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH;
        let fields = if authority_path {
            "files(id,createdTime)"
        } else {
            "files(id)"
        };
        let url = format!(
            "{}/drive/v3/files?q={}&fields={fields}&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            // Same discipline as `resolve_file_id`: never collapse a transient
            // failure into "not found", or delete will silently skip a live slot.
            if status.as_u16() == 401 {
                return Err(SyncError::Auth(
                    "Drive: 401 resolving shared file id".to_string(),
                ));
            }
            // 403 treated as transient (quota subclass); same rationale as
            // find_folder / resolve_file_id.
            //
            // NOTE: this is the terminal file-list step inside
            // `resolve_shared_file_id`, but it intentionally keeps its own
            // inline status check rather than delegating to
            // `classify_list_status`. The difference is that `Ok(None)` here
            // means genuine file absence (all preceding folder-walk segments
            // resolved successfully, the file itself is simply not present),
            // whereas in intermediate walk steps `Ok(None)` means "folder
            // segment missing". The inline check makes the meaning locally
            // explicit and avoids coupling this final step to the helper's
            // semantics, which callers must keep aligned. Only consolidate
            // via `classify_list_status` if behavior can be proven identical.
            if status.as_u16() == 403 || status.as_u16() == 429 || status.is_server_error() {
                return Err(SyncError::Network(format!(
                    "Drive resolve shared file failed: {status}"
                )));
            }
            return Ok(None);
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fi {
            id: String,
            #[serde(default)]
            created_time: String,
        }
        let mut list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        if list.files.len() > 1 && !authority_path {
            return Err(SyncError::Auth(format!(
                "duplicate shared path is ambiguous: {path}"
            )));
        }
        list.files.sort_by(|left, right| {
            left.created_time
                .cmp(&right.created_time)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(list.files.into_iter().next().map(|f| f.id))
    }

    /// Write a file at a shared path (e.g. `.meta/keyring.json`) anchored at
    /// the Memlore root folder. Creates the subfolder and file if absent;
    /// overwrites (PATCH) if the file already exists. Idempotent.
    pub async fn write_shared_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        if is_recovery_authority_path(path) {
            return Err(SyncError::Auth(
                "reserved recovery authority requires conditional mutation".to_string(),
            ));
        }
        self.write_shared_file_inner(path, data).await
    }

    async fn write_shared_file_inner(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let parsed = parse_shared_path(path)?;
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let SharedDrivePath::MetaFile {
            ref subfolder_path,
            ref filename,
        } = parsed;

        // Ensure root folder is known.
        let root_id = {
            let lock = self.root_folder_id.read().await;
            lock.clone()
        };
        let root_id = match root_id {
            Some(id) => id,
            None => {
                let id = self
                    .find_or_create_folder("Memlore", APPDATA_FOLDER)
                    .await?;
                *self.root_folder_id.write().await = Some(id.clone());
                id
            }
        };

        // Walk + create each subfolder segment so multi-level shared paths
        // (e.g. `.meta/keyring/devices/<id>.json`) get the full chain
        // materialised on first write. `find_or_create_folder` is idempotent.
        let mut subfolder_id = root_id;
        for segment in subfolder_path {
            subfolder_id = self.find_or_create_folder(segment, &subfolder_id).await?;
        }
        let token = self.ensure_fresh_token().await?;

        // Check whether the file already exists in the subfolder.
        let q = format!(
            "name = '{}' and '{}' in parents and trashed = false",
            escape_drive_query(filename),
            escape_drive_query(&subfolder_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(id)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q)
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        // Fail-closed: never create on an inconclusive lookup. A non-2xx
        // response here must propagate as an error — falling through to the
        // CREATE branch on a 429/5xx/401 would produce a duplicate file.
        // Only a genuine 2xx-empty result means "absent → safe to create".
        classify_list_status(resp.status())?;
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        #[derive(serde::Deserialize)]
        struct Fi {
            id: String,
        }
        let existing_id = {
            let list: Fl = resp
                .json()
                .await
                .map_err(|e| SyncError::Serialization(e.to_string()))?;
            list.files.into_iter().next().map(|f| f.id)
        };

        if let Some(file_id) = existing_id {
            // Update existing file in-place.
            let url = format!(
                "{}/drive/v3/files/{}?uploadType=media",
                self.upload_base, file_id
            );
            self.revalidate_recovery_fence_before_mutation(path).await?;
            let resp = self
                .http
                .patch(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .body(data.to_vec())
                .send()
                .await
                .map_err(|e| SyncError::Network(e.to_string()))?;
            if !resp.status().is_success() {
                return Err(SyncError::Network(format!(
                    "Drive update shared failed ({}): {path}",
                    resp.status()
                )));
            }
        } else {
            // Create new file via multipart upload.
            let metadata = serde_json::json!({ "name": filename, "parents": [subfolder_id] });
            let meta_str = metadata.to_string();
            let boundary = {
                let mut raw = [0u8; 16];
                rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut raw);
                format!("memlore_{}", hex::encode(raw))
            };
            let mut body: Vec<u8> = format!(
                "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta_str}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n"
            )
            .into_bytes();
            body.extend_from_slice(data);
            body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());

            let url = format!("{}/drive/v3/files?uploadType=multipart", self.upload_base);
            self.revalidate_recovery_fence_before_mutation(path).await?;
            let resp = self
                .http
                .post(&url)
                .bearer_auth(&token)
                .header(
                    "Content-Type",
                    format!("multipart/related; boundary={boundary}"),
                )
                .body(body)
                .send()
                .await
                .map_err(|e| SyncError::Network(e.to_string()))?;
            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                return Err(SyncError::Network(format!(
                    "Drive write shared failed ({status}): {text}"
                )));
            }
        }
        Ok(())
    }
}

// ─── Extra helpers (user info + storage quota) ───────────────────────────────

/// Authenticated user info from Google's userinfo endpoint.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct UserInfo {
    pub email: Option<String>,
    pub name: Option<String>,
}

/// Storage quota numbers from the Drive about endpoint.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageQuota {
    pub usage: Option<String>,
    pub limit: Option<String>,
}

/// Combined Drive `about` snapshot: account quota + signed-in email.
///
/// Email comes from `about.user.emailAddress`, which is available under the
/// `drive.appdata` scope. The OAuth2 userinfo endpoint is NOT used for email
/// because we deliberately do not request `openid` / `email` scopes.
#[derive(Debug, Clone)]
pub struct DriveAbout {
    pub quota: StorageQuota,
    pub email: Option<String>,
}

/// `KeyringV2Io` delegates to the existing `read_shared_file` /
/// `write_shared_file` shared-file I/O for reads and writes. For delete and
/// list, the V2 keyring paths live under `.meta/keyring/` which is within the
/// Memlore root folder; we implement these directly.
#[async_trait]
impl crate::sync::keyring_v2::KeyringV2Io for GDriveProvider {
    fn configure_recovery_fence(
        &self,
        local_generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
        self.configure_recovery_fence_authority(local_generation, permit);
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        self.read_shared_file(path).await
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        if is_recovery_authority_path(path) {
            return Err(SyncError::Auth(
                "reserved recovery authority requires conditional mutation".to_string(),
            ));
        }
        self.write_shared_file(path, data).await
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        if is_recovery_authority_path(path) {
            return Err(SyncError::Auth(
                "reserved recovery authority requires exact conditional deletion".to_string(),
            ));
        }
        self.revalidate_recovery_fence_before_mutation(path).await?;
        // V2 keyring paths are shared paths under `.meta/keyring/` (e.g.
        // `.meta/keyring/devices/{uuid}.json` — 4 segments). They must be
        // resolved via the shared-path resolver, NOT `resolve_file_id`
        // (`parse_drive_path`), which only accepts device-scoped 2–3 segment
        // paths and rejects these as "Invalid path".
        let file_id = match self.resolve_shared_file_id(path).await? {
            Some(id) => id,
            None => return Ok(()), // already gone
        };
        let token = self.ensure_fresh_token().await?;
        let url = format!("{}/drive/v3/files/{}", self.api_base, file_id);
        self.revalidate_recovery_fence_before_mutation(path).await?;
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if status.as_u16() == 204 || status.as_u16() == 404 || status.is_success() {
            return Ok(());
        }
        Err(SyncError::Network(format!(
            "Drive delete (keyring_v2) failed: {status}"
        )))
    }

    async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError> {
        // Allow-list which directories the keyring layer can enumerate. Today
        // only `.meta/keyring/devices` is listable (for `list_device_slots`).
        if !SHARED_LISTABLE_DIRS.contains(&prefix) {
            return Err(SyncError::Io(format!(
                "list_files prefix not in allow-list: {prefix}"
            )));
        }
        if prefix.split('/').any(|c| c == "..") {
            return Err(SyncError::Io(format!("Path traversal rejected: {prefix}")));
        }

        // Resolve the directory chain. Missing root or any segment means
        // "no entries yet" — return empty (callers handle this gracefully).
        let root_id = match self.ensure_root_folder_id_for_read().await? {
            Some(id) => id,
            None => return Ok(vec![]),
        };
        let token = self.ensure_fresh_token().await?;

        let mut parent_id = root_id;
        for segment in prefix.split('/') {
            parent_id = match self.find_folder(segment, &parent_id, &token).await? {
                Some(id) => id,
                None => return Ok(vec![]),
            };
        }

        // List children that are NOT folders. The slot files are tiny JSON
        // objects so paging isn't a concern at realistic device counts; the
        // single page (Drive default ~100 results) is more than enough.
        let q = format!(
            "'{}' in parents and mimeType != 'application/vnd.google-apps.folder' \
             and trashed = false",
            escape_drive_query(&parent_id),
        );
        let url = format!(
            "{}/drive/v3/files?q={}&fields=files(name)&spaces={APPDATA_FOLDER}",
            self.api_base,
            urlencoding_encode(&q),
        );
        let http = &self.http;
        let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        let status = resp.status();
        if status.as_u16() == 401 {
            return Err(SyncError::Auth("Drive: 401 listing shared dir".to_string()));
        }
        if !status.is_success() {
            return Err(SyncError::Network(format!(
                "Drive list shared dir failed: {status}"
            )));
        }
        #[derive(serde::Deserialize)]
        struct Fl {
            files: Vec<Fi>,
        }
        #[derive(serde::Deserialize)]
        struct Fi {
            name: String,
        }
        let list: Fl = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;

        // Caller (`list_device_slots`) wants full paths under root so it can
        // pass each one to `read_file`. Re-prefix with the directory.
        Ok(list
            .files
            .into_iter()
            .map(|f| format!("{prefix}/{}", f.name))
            .collect())
    }

    async fn read_versioned_file(
        &self,
        path: &str,
    ) -> Result<crate::sync::keyring_v2::VersionedFile, SyncError> {
        parse_shared_path(path)?;
        let file_id = self
            .resolve_shared_file_id(path)
            .await?
            .ok_or_else(|| SyncError::NotFound(path.to_string()))?;
        let token = self.ensure_fresh_token().await?;
        let url = format!("{}/drive/v3/files/{}?alt=media", self.api_base, file_id);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if resp.status().as_u16() == 404 {
            return Err(SyncError::NotFound(path.to_string()));
        }
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive versioned read failed ({}): {path}",
                resp.status()
            )));
        }
        // Prefer media-response ETag (same HTTP exchange as the body).
        // Real Drive often omits ETag on alt=media and even on metadata —
        // fall back to File.version, then content sha256 so connect can
        // still snapshot a revision for mid-flow revalidation.
        let header_revision = etag_from_headers(resp.headers());
        let bytes = resp
            .bytes()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if bytes.len() > 8 * 1024 {
            return Err(SyncError::Io(format!(
                "Versioned shared file response too large: {path}"
            )));
        }
        let revision = if let Some(revision) = header_revision {
            revision
        } else if let Some(revision) = self
            .fetch_drive_file_revision_fallback(&file_id, &token, path)
            .await?
        {
            revision
        } else {
            content_sha256_revision(&bytes)
        };
        Ok(crate::sync::keyring_v2::VersionedFile {
            bytes: bytes.to_vec(),
            revision,
        })
    }

    async fn compare_and_swap_file(
        &self,
        path: &str,
        expected_revision: &str,
        data: &[u8],
    ) -> Result<crate::sync::keyring_v2::ConditionalMutationResult, SyncError> {
        parse_shared_path(path)?;
        if path != crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH {
            return Err(SyncError::Auth(
                "conditional update is reserved for recovery control".to_string(),
            ));
        }
        let Some(file_id) = self.resolve_shared_file_id(path).await? else {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::NotFound);
        };
        let token = self.ensure_fresh_token().await?;
        if !is_http_etag_revision(expected_revision) {
            if let Some(result) = self
                .ensure_synthetic_revision_precondition(&file_id, &token, path, expected_revision)
                .await?
            {
                return Ok(result);
            }
        }
        let url = format!(
            "{}/drive/v3/files/{}?uploadType=media",
            self.upload_base, file_id
        );
        let mut req = self
            .http
            .patch(&url)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .body(data.to_vec());
        if is_http_etag_revision(expected_revision) {
            req = req.header(reqwest::header::IF_MATCH, expected_revision);
        }
        let resp = req
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if resp.status().as_u16() == 412 {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::Conflict);
        }
        if resp.status().as_u16() == 404 {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::NotFound);
        }
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive conditional update failed ({}): {path}",
                resp.status()
            )));
        }
        Ok(crate::sync::keyring_v2::ConditionalMutationResult::Applied)
    }

    async fn create_initial_control_if_absent(
        &self,
        data: &[u8],
    ) -> Result<crate::sync::keyring_v2::ConditionalMutationResult, SyncError> {
        let path = crate::sync::sync_control::SYNC_CONTROL_DRIVE_PATH;
        if self.resolve_shared_file_id(path).await?.is_some() {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::Conflict);
        }
        self.create_reserved_shared_file_and_reconcile(path, data)
            .await?;
        Ok(crate::sync::keyring_v2::ConditionalMutationResult::Applied)
    }

    async fn create_recovery_marker_if_absent(
        &self,
        data: &[u8],
        permit: &crate::sync::recovery::RecoveryOwnerPermit,
    ) -> Result<crate::sync::keyring_v2::ConditionalMutationResult, SyncError> {
        let marker: crate::sync::keyring_v2::RecoveryMarker = serde_json::from_slice(data)
            .map_err(|error| SyncError::Serialization(error.to_string()))?;
        let control = crate::sync::recovery::read_sync_control(self)
            .await?
            .ok_or_else(|| SyncError::Auth("recovery control is missing".to_string()))?;
        let exact_owner = control.recovery_lease.as_ref() == Some(&marker)
            && marker.job_id == permit.job_id
            && marker.owner_device_id == permit.owner_device_id
            && marker.operation == permit.operation
            && marker.recovery_generation == permit.recovery_generation
            && marker.nonce == permit.nonce;
        if !exact_owner {
            return Err(SyncError::Auth(
                "recovery marker create requires exact active control owner".to_string(),
            ));
        }
        let path = crate::sync::keyring_v2::RECOVERY_MARKER_PATH;
        if self.resolve_shared_file_id(path).await?.is_some() {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::Conflict);
        }
        self.create_reserved_shared_file_and_reconcile(path, data)
            .await?;
        Ok(crate::sync::keyring_v2::ConditionalMutationResult::Applied)
    }

    async fn delete_file_if_revision(
        &self,
        path: &str,
        expected_revision: &str,
    ) -> Result<crate::sync::keyring_v2::ConditionalMutationResult, SyncError> {
        parse_shared_path(path)?;
        if path != crate::sync::keyring_v2::RECOVERY_MARKER_PATH {
            return Err(SyncError::Auth(
                "conditional deletion is reserved for recovery marker".to_string(),
            ));
        }
        let Some(file_id) = self.resolve_shared_file_id(path).await? else {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::NotFound);
        };
        let token = self.ensure_fresh_token().await?;
        if !is_http_etag_revision(expected_revision) {
            if let Some(result) = self
                .ensure_synthetic_revision_precondition(&file_id, &token, path, expected_revision)
                .await?
            {
                return Ok(result);
            }
        }
        let url = format!("{}/drive/v3/files/{}", self.api_base, file_id);
        let mut req = self.http.delete(&url).bearer_auth(&token);
        if is_http_etag_revision(expected_revision) {
            req = req.header(reqwest::header::IF_MATCH, expected_revision);
        }
        let resp = req
            .send()
            .await
            .map_err(|error| SyncError::Network(error.to_string()))?;
        if resp.status().as_u16() == 412 {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::Conflict);
        }
        if resp.status().as_u16() == 404 {
            return Ok(crate::sync::keyring_v2::ConditionalMutationResult::NotFound);
        }
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "Drive conditional delete failed ({}): {path}",
                resp.status()
            )));
        }
        Ok(crate::sync::keyring_v2::ConditionalMutationResult::Applied)
    }
}

impl GDriveProvider {
    /// Fetch the authenticated user's email via Google's userinfo endpoint.
    pub async fn fetch_user_info(&self) -> Result<UserInfo, SyncError> {
        let token = self.ensure_fresh_token().await?;
        let url = format!("{}/oauth2/v3/userinfo", self.api_base);

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "userinfo failed: {}",
                resp.status()
            )));
        }
        resp.json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))
    }

    /// Fetch storage quota + signed-in email via Drive's `about` endpoint.
    ///
    /// Uses `fields=user(emailAddress),storageQuota` so a single cheap call
    /// covers both the free-space line and the account chip in Settings.
    /// Prefer this over `fetch_user_info` for email — userinfo needs scopes we
    /// do not request (`openid` / `email`).
    pub async fn fetch_drive_about(&self) -> Result<DriveAbout, SyncError> {
        let token = self.ensure_fresh_token().await?;
        let url = format!(
            "{}/drive/v3/about?fields=user(emailAddress),storageQuota",
            self.api_base
        );

        let resp = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "about failed: {}",
                resp.status()
            )));
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AboutResponse {
            storage_quota: StorageQuota,
            user: Option<AboutUser>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AboutUser {
            email_address: Option<String>,
        }
        let about: AboutResponse = resp
            .json()
            .await
            .map_err(|e| SyncError::Serialization(e.to_string()))?;
        let email = about
            .user
            .and_then(|u| u.email_address)
            .filter(|s| !s.is_empty());
        Ok(DriveAbout {
            quota: about.storage_quota,
            email,
        })
    }

    /// Fetch storage quota via Drive's `about` endpoint.
    pub async fn fetch_storage_quota(&self) -> Result<StorageQuota, SyncError> {
        Ok(self.fetch_drive_about().await?.quota)
    }

    /// Sum byte sizes of every non-folder file this app owns in Drive
    /// `appDataFolder` (the hidden Application Data space).
    ///
    /// That space is exclusive to this OAuth client, so the total is exactly
    /// what Memlore occupies on the user's Google account — not Photos, Gmail,
    /// or other Drive apps. Folders are excluded (they have no `size`). Pages
    /// through `nextPageToken` so large libraries still sum correctly.
    pub async fn fetch_appdata_usage_bytes(&self) -> Result<u64, SyncError> {
        let token = self.ensure_fresh_token().await?;
        // Exclude folders: Google returns `size` only for binary files.
        let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
        let mut total: u64 = 0;
        let mut page_token: Option<String> = None;

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FileList {
            files: Option<Vec<FileSize>>,
            next_page_token: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct FileSize {
            /// Drive returns size as a decimal string; absent for folders
            /// (already filtered out) and some Google Docs types we never write.
            size: Option<String>,
        }

        loop {
            let mut url = format!(
                "{}/drive/v3/files?spaces={APPDATA_FOLDER}&pageSize=1000&fields=nextPageToken,files(size)&q={}",
                self.api_base,
                urlencoding_encode(q),
            );
            if let Some(ref pt) = page_token {
                url.push_str("&pageToken=");
                url.push_str(&urlencoding_encode(pt));
            }

            let http = &self.http;
            let resp = send_with_retry(|| http.get(&url).bearer_auth(&token))
                .await
                .map_err(|e| SyncError::Network(e.to_string()))?;
            classify_list_status(resp.status())?;

            let list: FileList = resp
                .json()
                .await
                .map_err(|e| SyncError::Serialization(e.to_string()))?;

            for f in list.files.unwrap_or_default() {
                if let Some(size_str) = f.size {
                    if let Ok(n) = size_str.parse::<u64>() {
                        total = total.saturating_add(n);
                    }
                }
            }

            match list.next_page_token {
                Some(next) if !next.is_empty() => page_token = Some(next),
                _ => break,
            }
        }

        Ok(total)
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Build a session with a far-future expiry so `ensure_fresh_token` won't
    /// attempt a refresh in tests that only care about Drive API calls.
    fn make_session(access_token: &str) -> GDriveSession {
        GDriveSession {
            access_token: access_token.to_string(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
            refresh_token: Zeroizing::new("dummy-refresh".to_string()),
            client_id: "test-client-id".to_string(),
            client_secret: "test-client-secret".to_string(),
        }
    }

    // ─── fetch_drive_about ───────────────────────────────────────────────────

    #[tokio::test]
    async fn fetch_drive_about_returns_quota_and_email() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/about"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user": { "emailAddress": "user@example.com" },
                "storageQuota": {
                    "usage": "1000",
                    "limit": "5000"
                }
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let about = provider.fetch_drive_about().await.unwrap();
        assert_eq!(about.email.as_deref(), Some("user@example.com"));
        assert_eq!(about.quota.usage.as_deref(), Some("1000"));
        assert_eq!(about.quota.limit.as_deref(), Some("5000"));
    }

    // ─── fetch_appdata_usage_bytes ───────────────────────────────────────────

    #[tokio::test]
    async fn fetch_appdata_usage_bytes_sums_sizes_across_pages() {
        let mock = MockServer::start().await;

        // Page 1: two files + nextPageToken
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .and(query_param("pageSize", "1000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    { "size": "100" },
                    { "size": "250" },
                    // Folders / missing size must not break the sum.
                    {},
                ],
                "nextPageToken": "page-2"
            })))
            .up_to_n_times(1)
            .mount(&mock)
            .await;

        // Page 2: final page
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .and(query_param("pageToken", "page-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    { "size": "50" }
                ]
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let total = provider.fetch_appdata_usage_bytes().await.unwrap();
        assert_eq!(total, 400);
    }

    #[tokio::test]
    async fn fetch_appdata_usage_bytes_returns_zero_when_empty() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": []
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let total = provider.fetch_appdata_usage_bytes().await.unwrap();
        assert_eq!(total, 0);
    }

    // ─── ensure_fresh_token ──────────────────────────────────────────────────

    #[tokio::test]
    async fn ensure_fresh_token_returns_current_when_not_expired() {
        let mock = MockServer::start().await;
        let provider =
            GDriveProvider::new(make_session("current-token"), &mock.uri(), &mock.uri()).unwrap();
        let token = provider.ensure_fresh_token().await.unwrap();
        assert_eq!(token, "current-token");
    }

    #[tokio::test]
    async fn ensure_fresh_token_refreshes_when_expired() {
        let mock = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.refreshed",
                "expires_in": 3600,
                "token_type": "Bearer"
            })))
            .mount(&mock)
            .await;

        let mut session = make_session("old-token");
        session.expires_at = std::time::Instant::now() - std::time::Duration::from_secs(10);

        let provider = GDriveProvider::new(session, &mock.uri(), &mock.uri()).unwrap();
        let token = provider.ensure_fresh_token().await.unwrap();
        assert_eq!(token, "ya29.refreshed");
    }

    // ─── list_devices ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_devices_parses_response_and_sorts() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    {"id": "id1", "name": "device-b"},
                    {"id": "id2", "name": "device-a"}
                ]
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let devices = provider.list_devices().await.unwrap();
        assert_eq!(devices, vec!["device-a", "device-b"]);
    }

    /// Phase 1 dual-read: with the recovery fence on and no `generations/`
    /// namespace, list_devices must still surface legacy flat device folders
    /// under the Memlore root (not silently return empty).
    #[tokio::test]
    async fn list_devices_dual_reads_flat_layout_when_generation_namespace_absent() {
        use wiremock::matchers::query_param_contains;
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct FlatLegacyListResponder;
        impl Respond for FlatLegacyListResponder {
            fn respond(&self, request: &Request) -> RT {
                let url = request.url.to_string();
                if url.contains("generations") {
                    RT::new(200).set_body_json(serde_json::json!({ "files": [] }))
                } else {
                    RT::new(200).set_body_json(serde_json::json!({
                        "files": [
                            {"id": "id1", "name": "device-b"},
                            {"id": "id2", "name": "device-a"},
                            {"id": "id3", "name": ".meta"},
                            {"id": "id4", "name": "generations"}
                        ]
                    }))
                }
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType"))
            .respond_with(FlatLegacyListResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let devices = provider.list_devices().await.unwrap();
        assert_eq!(
            devices,
            vec!["device-a", "device-b"],
            "flat-only vaults must list devices; reserved roots filtered"
        );
    }

    #[test]
    fn payload_device_folder_name_rejects_reserved_root_siblings() {
        assert!(is_payload_device_folder_name("device-a"));
        assert!(!is_payload_device_folder_name(".meta"));
        assert!(!is_payload_device_folder_name("generations"));
    }

    /// Regression: the reserved `.meta` keyring folder (preserved across
    /// "Wipe cloud + disconnect") must not be reported as a peer device.
    /// Otherwise a reconnect-after-wipe surfaces a spurious
    /// `peer .meta: invalid device ID, skipping` warning.
    #[tokio::test]
    async fn list_devices_filters_reserved_meta_folder() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    {"id": "id1", "name": ".meta"},
                    {"id": "id2", "name": "device-a"}
                ]
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let devices = provider.list_devices().await.unwrap();
        assert_eq!(devices, vec!["device-a"]);
    }

    #[tokio::test]
    async fn list_devices_returns_empty_when_no_root_folder() {
        let mock = MockServer::start().await;
        // root_folder_id is None → list_devices now triggers the lazy
        // canonical-root discovery query (after the I1 hardening). Mock
        // that query to return zero matches, which is the "user has no
        // Memlore folder on Drive yet" case. list_devices must surface
        // an empty list (not an error).
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .expect(1)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let devices = provider.list_devices().await.unwrap();
        assert!(devices.is_empty());
    }

    /// Regression for I1: on a cold provider, the canonical-root discovery
    /// query that `ensure_root_folder_id_for_read` issues must surface 401
    /// as `SyncError::Auth` so the OAuth reconnect signal still fires.
    /// Previously a 401 here was swallowed into `Ok(None)`, making every
    /// downstream read return "empty / not found" silently.
    #[tokio::test]
    async fn list_devices_surfaces_auth_error_on_401_during_lazy_root_discovery() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let err = provider.list_devices().await.unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "401 from canonical-root query must propagate as Auth, got {err:?}"
        );
    }

    #[tokio::test]
    async fn list_devices_maps_401_to_auth_error() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider.list_devices().await.unwrap_err();
        assert!(matches!(err, SyncError::Auth(_)));
    }

    // ─── delete_file idempotent ──────────────────────────────────────────────

    #[tokio::test]
    async fn delete_file_is_idempotent_when_file_not_found() {
        // Without root_folder_id, resolve_file_id returns None immediately.
        let mock = MockServer::start().await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let result = provider.delete_file("dev-a/entries/file.bin").await;
        assert!(
            result.is_ok(),
            "delete_file must return Ok when file not found"
        );
    }

    #[tokio::test]
    async fn delete_file_returns_ok_on_404_response() {
        let mock = MockServer::start().await;

        // resolve_file_id path: find root→device→entries→file.
        // First call: list devices folder (find_folder "Memlore") — returns root.
        // Second: list device folder — returns device-id.
        // Third: list entries folder — returns entries-id.
        // Fourth: list file — returns file-id.
        // Then DELETE returns 404.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "fileid"}] })),
            )
            .mount(&mock)
            .await;

        Mock::given(method("DELETE"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let result = provider.delete_file("dev-a/entries/file.bin").await;
        assert!(result.is_ok(), "delete with 404 must be Ok");
    }

    /// Critical dual-layout regression: after migrate-on-write the same
    /// basename can exist under both `generations/g-N/<device>/…` and flat
    /// `Memlore/<device>/…`. Prefer-gen dual-read would only DELETE the gen
    /// file_id, leaving a flat orphan that resolve/list resurrect. Delete
    /// must remove every match so dual-read cannot resurrect "deleted"
    /// content.
    #[tokio::test]
    async fn delete_file_removes_gen_and_flat_copies_so_dual_read_cannot_resurrect() {
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex};
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        #[derive(Default)]
        struct DualDeleteState {
            deleted: HashSet<String>,
        }

        struct DualDeleteResponder {
            state: Arc<Mutex<DualDeleteState>>,
        }

        impl Respond for DualDeleteResponder {
            fn respond(&self, request: &Request) -> RT {
                let method = request.method.as_str();
                let path = request.url.path();

                if method == "DELETE" {
                    if let Some(file_id) = path.strip_prefix("/drive/v3/files/") {
                        self.state
                            .lock()
                            .expect("dual-delete state lock")
                            .deleted
                            .insert(file_id.to_string());
                        return RT::new(204);
                    }
                }

                // Recovery fence: download control.json body.
                if method == "GET" && path == "/drive/v3/files/control-id" {
                    return RT::new(200).set_body_json(serde_json::json!({
                        "version": 1,
                        "recovery_generation": 1,
                        "recovery_lease": null,
                        "updated_at": 1,
                    }));
                }

                if method != "GET" || path != "/drive/v3/files" {
                    return RT::new(404);
                }

                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let deleted = self
                    .state
                    .lock()
                    .expect("dual-delete state lock")
                    .deleted
                    .clone();

                let body = if q.contains("name = '.meta'") {
                    serde_json::json!({ "files": [{"id": "meta-id"}] })
                } else if q.contains("name = 'control.json'") {
                    serde_json::json!({ "files": [{"id": "control-id"}] })
                } else if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'gen-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'gen-media-id' in parents") {
                    if deleted.contains("gen-file-id") {
                        serde_json::json!({ "files": [] })
                    } else {
                        serde_json::json!({ "files": [{"id": "gen-file-id"}] })
                    }
                } else if q.contains("name = 'dev-uuid'") && q.contains("'root-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'flat-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'flat-media-id' in parents")
                {
                    if deleted.contains("flat-file-id") {
                        serde_json::json!({ "files": [] })
                    } else {
                        serde_json::json!({ "files": [{"id": "flat-file-id"}] })
                    }
                } else if q.contains("'gen-media-id' in parents") && q.contains("mimeType !=") {
                    if deleted.contains("gen-file-id") {
                        serde_json::json!({ "files": [] })
                    } else {
                        serde_json::json!({ "files": [{"id": "gen-file-id", "name": "abc123"}] })
                    }
                } else if q.contains("'flat-media-id' in parents") && q.contains("mimeType !=") {
                    if deleted.contains("flat-file-id") {
                        serde_json::json!({ "files": [] })
                    } else {
                        serde_json::json!({ "files": [{"id": "flat-file-id", "name": "abc123"}] })
                    }
                } else {
                    serde_json::json!({ "files": [] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let state = Arc::new(Mutex::new(DualDeleteState::default()));
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(DualDeleteResponder {
                state: Arc::clone(&state),
            })
            .mount(&mock)
            .await;
        Mock::given(method("DELETE"))
            .respond_with(DualDeleteResponder {
                state: Arc::clone(&state),
            })
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        // Precondition: dual-read prefers gen while both copies exist.
        assert_eq!(
            provider
                .resolve_file_id("dev-uuid/media/abc123")
                .await
                .unwrap()
                .as_deref(),
            Some("gen-file-id"),
        );
        let listed_before = provider
            .list_files("dev-uuid", FileKind::Media)
            .await
            .unwrap();
        assert!(
            listed_before.iter().any(|p| p == "dev-uuid/media/abc123"),
            "precondition: basename must list, got {listed_before:?}"
        );

        provider
            .delete_file("dev-uuid/media/abc123")
            .await
            .expect("dual-layout delete must succeed");

        let deleted = state
            .lock()
            .expect("dual-delete state lock")
            .deleted
            .clone();
        assert!(
            deleted.contains("gen-file-id"),
            "must DELETE gen copy, deleted={deleted:?}"
        );
        assert!(
            deleted.contains("flat-file-id"),
            "must DELETE flat orphan, deleted={deleted:?}"
        );

        assert_eq!(
            provider
                .resolve_file_id("dev-uuid/media/abc123")
                .await
                .unwrap(),
            None,
            "after dual delete, resolve_file_id must not resurrect either layout"
        );
        let listed_after = provider
            .list_files("dev-uuid", FileKind::Media)
            .await
            .unwrap();
        assert!(
            !listed_after.iter().any(|p| p == "dev-uuid/media/abc123"),
            "list_files must not surface deleted basename, got {listed_after:?}"
        );
    }

    // ─── read_file ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn read_file_returns_not_found_when_root_folder_missing() {
        let mock = MockServer::start().await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let err = provider
            .read_file("dev-a/entries/missing.bin")
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    // ─── read_file_if_changed (Phase 2, Task 2) ──────────────────────────────
    //
    // These tests stand up a single mock that answers three shapes of GET
    // against /drive/v3/files:
    //   1. list/resolve queries (?q=...) → {"files":[{"id":"file-id"}]}
    //   2. metadata precheck (?fields=modifiedTime,md5Checksum,sha256Checksum,size)
    //   3. media body (?alt=media) → the file bytes
    // The responder inspects the query string to decide which answer to give,
    // mirroring the EmptyGenShadowResolveResponder pattern used elsewhere.

    /// Shared setup: provider with root_folder_id pre-populated so the mock
    /// only needs to answer the per-file GETs. The recovery fence is left OFF
    /// so file-id resolution takes the simple flat-layout path — the
    /// conditional-read feature is orthogonal to the generation dual-read.
    async fn conditional_read_provider(mock_uri: &str) -> GDriveProvider {
        let provider = GDriveProvider::new(make_session("tok"), mock_uri, mock_uri).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());
        provider
    }

    #[tokio::test]
    async fn gdrive_read_if_changed_returns_unchanged_when_revision_matches() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        let body_bytes = b"hello-drive".to_vec();
        let sha_token = content_sha256_revision(&body_bytes);
        let sha_hex_only = sha_token
            .strip_prefix(REV_CONTENT_SHA_PREFIX)
            .map(|s| s.to_string())
            .unwrap();

        struct CondReadResponder {
            sha_hex: String,
            body: Vec<u8>,
        }
        impl Respond for CondReadResponder {
            fn respond(&self, request: &Request) -> RT {
                let url = request.url.to_string();
                // File-id resolution (list query).
                if url.contains("q=") {
                    return RT::new(200)
                        .set_body_json(serde_json::json!({ "files": [{"id": "file-id"}] }));
                }
                // Metadata precheck.
                if url.contains("fields=modifiedTime") {
                    return RT::new(200).set_body_json(serde_json::json!({
                        "sha256Checksum": self.sha_hex,
                        "md5Checksum": "deadbeef",
                        "modifiedTime": "2026-07-28T00:00:00.000Z",
                        "size": self.body.len().to_string()
                    }));
                }
                // Media body download.
                if url.contains("alt=media") {
                    return RT::new(200).set_body_bytes(self.body.clone());
                }
                RT::new(404)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(CondReadResponder {
                sha_hex: sha_hex_only,
                body: body_bytes.clone(),
            })
            .mount(&mock)
            .await;

        let provider = conditional_read_provider(&mock.uri()).await;

        // Caller hands back the sha revision derived from the same bytes →
        // the metadata precheck reproduces it → Unchanged, NO body download.
        let got = provider
            .read_file_if_changed("dev-a/entries/e1.bin", Some(&sha_token))
            .await
            .unwrap();
        assert_eq!(got, ConditionalRead::Unchanged);

        // The provider can only return Unchanged by short-circuiting BEFORE
        // the alt=media download (the responder would otherwise return the
        // body and the provider would compute a Changed sha). So the
        // Unchanged assertion above is the load-bearing proof that the
        // metadata precheck skipped the body download.
    }

    #[tokio::test]
    async fn gdrive_read_if_changed_returns_changed_when_revision_differs() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        let body_bytes = b"new-content".to_vec();

        struct ChangedResponder {
            body: Vec<u8>,
        }
        impl Respond for ChangedResponder {
            fn respond(&self, request: &Request) -> RT {
                let url = request.url.to_string();
                if url.contains("q=") {
                    return RT::new(200)
                        .set_body_json(serde_json::json!({ "files": [{"id": "file-id"}] }));
                }
                if url.contains("fields=modifiedTime") {
                    // Metadata reports a DIFFERENT sha than the caller's stale one.
                    return RT::new(200).set_body_json(serde_json::json!({
                        "sha256Checksum": "aaaabbbbccccdddd",
                        "md5Checksum": "11223344",
                        "modifiedTime": "2026-07-28T00:00:00.000Z",
                        "size": self.body.len().to_string()
                    }));
                }
                if url.contains("alt=media") {
                    return RT::new(200).set_body_bytes(self.body.clone());
                }
                RT::new(404)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ChangedResponder {
                body: body_bytes.clone(),
            })
            .mount(&mock)
            .await;

        let provider = conditional_read_provider(&mock.uri()).await;

        // Caller's cached revision is stale (sha256:stale) → must download and
        // return Changed with the real content sha of the downloaded bytes.
        let got = provider
            .read_file_if_changed("dev-a/entries/e1.bin", Some("sha256:stale"))
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, body_bytes);
                let rev = revision.expect("gdrive resolves a sha revision on download");
                assert_eq!(rev, content_sha256_revision(&body_bytes));
            }
            ConditionalRead::Unchanged => panic!("stale revision must be Changed"),
        }
    }

    #[tokio::test]
    async fn gdrive_read_if_changed_none_revision_skips_precheck_and_downloads() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        let body_bytes = b"cold-bytes".to_vec();

        struct ColdReadResponder {
            body: Vec<u8>,
            saw_metadata: std::sync::Arc<std::sync::atomic::AtomicBool>,
        }
        impl Respond for ColdReadResponder {
            fn respond(&self, request: &Request) -> RT {
                let url = request.url.to_string();
                if url.contains("q=") {
                    return RT::new(200)
                        .set_body_json(serde_json::json!({ "files": [{"id": "file-id"}] }));
                }
                if url.contains("fields=modifiedTime") {
                    self.saw_metadata
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    return RT::new(200).set_body_json(serde_json::json!({
                        "sha256Checksum": "abcdef",
                        "md5Checksum": "11223344",
                        "modifiedTime": "2026-07-28T00:00:00.000Z",
                        "size": self.body.len().to_string()
                    }));
                }
                if url.contains("alt=media") {
                    return RT::new(200).set_body_bytes(self.body.clone());
                }
                RT::new(404)
            }
        }

        let saw_metadata = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ColdReadResponder {
                body: body_bytes.clone(),
                saw_metadata: saw_metadata.clone(),
            })
            .mount(&mock)
            .await;

        let provider = conditional_read_provider(&mock.uri()).await;

        // known_revision: None → MUST skip the metadata precheck entirely and
        // go straight to the body download (None-invariant: bytes always back).
        let got = provider
            .read_file_if_changed("dev-a/entries/e1.bin", None)
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, body_bytes);
                let rev = revision.expect("gdrive resolves a sha revision on download");
                assert_eq!(rev, content_sha256_revision(&body_bytes));
            }
            ConditionalRead::Unchanged => panic!("None revision must never be Unchanged"),
        }
        assert!(
            !saw_metadata.load(std::sync::atomic::Ordering::SeqCst),
            "None known_revision must skip the metadata precheck"
        );
    }

    #[tokio::test]
    async fn gdrive_read_if_changed_returns_changed_when_metadata_has_no_checksum() {
        // Metadata precheck resolves no content checksum → provider cannot
        // confirm equality, so it MUST download and return Changed. The
        // returned revision is the post-download sha (not None, because we
        // resolved one from the bytes themselves).
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        let body_bytes = b"no-checksum-bytes".to_vec();

        struct NoChecksumResponder {
            body: Vec<u8>,
        }
        impl Respond for NoChecksumResponder {
            fn respond(&self, request: &Request) -> RT {
                let url = request.url.to_string();
                if url.contains("q=") {
                    return RT::new(200)
                        .set_body_json(serde_json::json!({ "files": [{"id": "file-id"}] }));
                }
                if url.contains("fields=modifiedTime") {
                    // No checksums at all — only mtime + size.
                    return RT::new(200).set_body_json(serde_json::json!({
                        "modifiedTime": "2026-07-28T00:00:00.000Z",
                        "size": self.body.len().to_string()
                    }));
                }
                if url.contains("alt=media") {
                    return RT::new(200).set_body_bytes(self.body.clone());
                }
                RT::new(404)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(NoChecksumResponder {
                body: body_bytes.clone(),
            })
            .mount(&mock)
            .await;

        let provider = conditional_read_provider(&mock.uri()).await;

        let got = provider
            .read_file_if_changed("dev-a/entries/e1.bin", Some("sha256:whatever"))
            .await
            .unwrap();
        match got {
            ConditionalRead::Changed { bytes, revision } => {
                assert_eq!(bytes, body_bytes);
                // We have the bytes, so we resolve a real sha revision (not None).
                let rev = revision.expect("downloaded bytes always yield a sha revision");
                assert_eq!(rev, content_sha256_revision(&body_bytes));
            }
            ConditionalRead::Unchanged => {
                panic!("unresolvable revision must never be Unchanged — must download")
            }
        }
    }

    #[tokio::test]
    async fn gdrive_read_if_changed_missing_file_returns_not_found() {
        let mock = MockServer::start().await;
        let provider = conditional_read_provider(&mock.uri()).await;
        // No mocks mounted → resolve_file_id finds nothing → NotFound before
        // any metadata/body request.
        let err = provider
            .read_file_if_changed("dev-a/entries/missing.bin", None)
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    /// Regression: when the provider is freshly reconstructed (e.g. inside
    /// `make_configured_provider` for an on-demand `resolve_media` call),
    /// `root_folder_id` starts as `None`. Reads must lazily discover the
    /// canonical `Memlore` folder via Drive search and proceed — not
    /// short-circuit to `NotFound` like the old code did.
    /// Phase 1 dual-read: fence on, no `generations/g-N` → resolve flat
    /// `Memlore/<device>/media/<file>` instead of Ok(None).
    #[tokio::test]
    async fn resolve_file_id_dual_reads_flat_layout_when_generation_namespace_absent() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct FlatResolveResponder;
        impl Respond for FlatResolveResponder {
            fn respond(&self, request: &Request) -> RT {
                let url = request.url.to_string();
                if url.contains("generations") {
                    return RT::new(200).set_body_json(serde_json::json!({ "files": [] }));
                }
                // Device folder, media subfolder, and file each return a match.
                RT::new(200).set_body_json(serde_json::json!({ "files": [{"id": "flat-match"}] }))
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(FlatResolveResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let resolved = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap();
        assert_eq!(
            resolved.as_deref(),
            Some("flat-match"),
            "legacy flat path must resolve when gen namespace is absent"
        );
    }

    /// Regression: empty `generations/g-N/<device>/…` must not shadow legacy
    /// flat payload. Phase 1 cutover creates empty gen device folders via
    /// `ensure_folder_structure` while vault data still lives flat.
    #[tokio::test]
    async fn resolve_file_id_dual_reads_flat_when_gen_device_folder_exists_but_empty() {
        use wiremock::matchers::query_param_contains;
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        /// Walk:
        /// 1. find `generations` under root → gen-root-id
        /// 2. find `g-1` under generations → g1-id
        /// 3. find device under g-1 → gen-dev-id (empty gen slot)
        /// 4. find media under gen-dev → gen-media-id
        /// 5. find file under gen-media → empty
        /// 6. find device under root (flat) → flat-dev-id
        /// 7. find media under flat-dev → flat-media-id
        /// 8. find file under flat-media → flat-file-id
        struct EmptyGenShadowResolveResponder;
        impl Respond for EmptyGenShadowResolveResponder {
            fn respond(&self, request: &Request) -> RT {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let body = if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'gen-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'gen-media-id' in parents") {
                    serde_json::json!({ "files": [] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'root-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'flat-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'flat-media-id' in parents")
                {
                    serde_json::json!({ "files": [{"id": "flat-file-id"}] })
                } else {
                    serde_json::json!({ "files": [] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("spaces", "appDataFolder"))
            .respond_with(EmptyGenShadowResolveResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let resolved = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap();
        assert_eq!(
            resolved.as_deref(),
            Some("flat-file-id"),
            "empty gen device folder must not hide flat payload"
        );
    }

    /// When the same filename exists under gen and flat, prefer gen.
    #[tokio::test]
    async fn resolve_file_id_prefers_gen_when_both_layouts_have_file() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct PreferGenResolveResponder;
        impl Respond for PreferGenResolveResponder {
            fn respond(&self, request: &Request) -> RT {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let body = if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'gen-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'gen-media-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-file-id"}] })
                } else {
                    // Flat lookups must not be required once gen hits;
                    // return a distinct id so accidental flat preference fails.
                    serde_json::json!({ "files": [{"id": "flat-file-id"}] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(PreferGenResolveResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let resolved = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap();
        assert_eq!(
            resolved.as_deref(),
            Some("gen-file-id"),
            "gen copy must win when both layouts have the same filename"
        );
    }

    /// Empty gen entries/ + flat entries/foo.yjs → list_files must surface foo.
    #[tokio::test]
    async fn list_files_dual_reads_flat_when_gen_device_folder_exists_but_empty() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct EmptyGenShadowListResponder;
        impl Respond for EmptyGenShadowListResponder {
            fn respond(&self, request: &Request) -> RT {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let body = if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("name = 'entries'") && q.contains("'gen-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-entries-id"}] })
                } else if q.contains("'gen-entries-id' in parents") && q.contains("mimeType !=") {
                    // Empty gen entries folder.
                    serde_json::json!({ "files": [] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'root-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-dev-id"}] })
                } else if q.contains("name = 'entries'") && q.contains("'flat-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-entries-id"}] })
                } else if q.contains("'flat-entries-id' in parents") && q.contains("mimeType !=") {
                    serde_json::json!({ "files": [{"id": "flat-foo-id", "name": "foo.yjs"}] })
                } else {
                    serde_json::json!({ "files": [] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(EmptyGenShadowListResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let files = provider
            .list_files("dev-uuid", FileKind::Entries)
            .await
            .unwrap();
        assert_eq!(
            files,
            vec!["dev-uuid/entries/foo.yjs".to_string()],
            "flat entries must appear when gen entries is empty"
        );
    }

    /// DeviceRoot is write-namespace only: a missing gen-namespace surface
    /// `.bin` must not be masked by a leftover flat copy. Otherwise hash-gate
    /// reconcile would keep the surface "clean" and never re-upload.
    #[tokio::test]
    async fn list_files_device_root_ignores_flat_when_gen_namespace_missing_bin() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct DeviceRootWriteNsResponder;
        impl Respond for DeviceRootWriteNsResponder {
            fn respond(&self, request: &Request) -> RT {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let body = if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("'gen-dev-id' in parents") && q.contains("mimeType !=") {
                    // Write namespace: settings.bin present, tags.bin missing.
                    serde_json::json!({
                        "files": [
                            {"id": "gen-settings-id", "name": "settings.bin"},
                            {"id": "gen-meta-id", "name": "metadata.json"}
                        ]
                    })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'root-id' in parents") {
                    // Flat leftover that dual-read would wrongly treat as present.
                    serde_json::json!({ "files": [{"id": "flat-dev-id"}] })
                } else if q.contains("'flat-dev-id' in parents") && q.contains("mimeType !=") {
                    serde_json::json!({
                        "files": [
                            {"id": "flat-tags-id", "name": "tags.bin"},
                            {"id": "flat-settings-id", "name": "settings.bin"}
                        ]
                    })
                } else {
                    serde_json::json!({ "files": [] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(DeviceRootWriteNsResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let files = provider
            .list_files("dev-uuid", FileKind::DeviceRoot)
            .await
            .unwrap();
        assert!(
            files.contains(&"dev-uuid/settings.bin".to_string()),
            "write-namespace settings.bin must appear: {files:?}"
        );
        assert!(
            files.contains(&"dev-uuid/metadata.json".to_string()),
            "write-namespace metadata.json must appear: {files:?}"
        );
        assert!(
            !files.iter().any(|p| p.ends_with("/tags.bin")),
            "flat-only tags.bin must NOT mask a missing write-namespace bin: {files:?}"
        );
    }

    /// Union of gen + flat; same basename prefers gen path identity.
    #[tokio::test]
    async fn list_files_merges_gen_and_flat_preferring_gen_on_name_collision() {
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct MergeListResponder;
        impl Respond for MergeListResponder {
            fn respond(&self, request: &Request) -> RT {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                let body = if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("name = 'entries'") && q.contains("'gen-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-entries-id"}] })
                } else if q.contains("'gen-entries-id' in parents") && q.contains("mimeType !=") {
                    serde_json::json!({
                        "files": [
                            {"id": "gen-shared-id", "name": "shared.yjs"},
                            {"id": "gen-only-id", "name": "gen-only.yjs"}
                        ]
                    })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'root-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-dev-id"}] })
                } else if q.contains("name = 'entries'") && q.contains("'flat-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-entries-id"}] })
                } else if q.contains("'flat-entries-id' in parents") && q.contains("mimeType !=") {
                    serde_json::json!({
                        "files": [
                            {"id": "flat-shared-id", "name": "shared.yjs"},
                            {"id": "flat-only-id", "name": "flat-only.yjs"}
                        ]
                    })
                } else {
                    serde_json::json!({ "files": [] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(MergeListResponder)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let files = provider
            .list_files("dev-uuid", FileKind::Entries)
            .await
            .unwrap();
        assert_eq!(
            files,
            vec![
                "dev-uuid/entries/flat-only.yjs".to_string(),
                "dev-uuid/entries/gen-only.yjs".to_string(),
                "dev-uuid/entries/shared.yjs".to_string(),
            ],
            "union must include both layouts; collision keeps a single shared.yjs entry"
        );
    }

    #[tokio::test]
    async fn resolve_file_id_lazily_populates_root_folder_id_on_read() {
        let mock = MockServer::start().await;

        // Every GET to /drive/v3/files returns one matching file. The
        // sequence the resolve path walks is:
        //   1. canonical-root query → {id: "root-id"}
        //   2. device-folder query  → {id: "dev-folder-id"}
        //   3. file query           → {id: "file-id"}
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "match"}] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // Sanity: starts empty.
        assert!(provider.root_folder_id.read().await.is_none());

        let resolved = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap();
        assert_eq!(resolved.as_deref(), Some("match"));

        // Cached after first lookup.
        assert_eq!(
            provider.root_folder_id.read().await.clone(),
            Some("match".to_string())
        );
    }

    /// If Drive truly has no `Memlore` folder (user revoked OAuth or
    /// deleted the folder out-of-band), the read path must still degrade
    /// to `NotFound` rather than panic or auto-create.
    #[tokio::test]
    async fn resolve_file_id_returns_none_when_drive_has_no_memlore_folder() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let resolved = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap();
        assert!(resolved.is_none());
        // Nothing cached either — next read can retry.
        assert!(provider.root_folder_id.read().await.is_none());
    }

    /// Regression: a 429 (rate-limit) from Drive's file-listing endpoint
    /// must surface as `SyncError::Network`, not be collapsed into
    /// `Ok(None)`. The old code returned `Ok(None)` for any non-2xx,
    /// which made `read_file` report `NotFound` for media that exists
    /// — the frontend then negative-cached the failure for 30 s and
    /// showed "tap to download" placeholders on first sync.
    #[tokio::test]
    async fn resolve_file_id_returns_network_error_on_429() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let err = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "expected Network error on 429, got {err:?}"
        );
    }

    /// Same hazard for 5xx — server errors are transient and must not be
    /// flattened to "file not present".
    #[tokio::test]
    async fn resolve_file_id_returns_network_error_on_5xx() {
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let err = provider
            .resolve_file_id("dev-uuid/media/abc123")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "expected Network error on 503, got {err:?}"
        );
    }

    // ─── KeyringV2Io::delete_file (shared 4-segment paths) ───────────────────
    //
    // Regression guard for the "Invalid path" bug: a device-slot path like
    // `.meta/keyring/devices/{uuid}.json` (4 segments) must route through the
    // shared-path resolver, NOT `resolve_file_id`/`parse_drive_path` (2–3
    // segment, device-scoped) which rejects it. publish_keyring deletes every
    // non-current slot through this method, so a re-misroute wedges revoke.
    // Use fully-qualified `KeyringV2Io::delete_file` calls (not a `use`) so the
    // trait's `list_files`/`read_file` don't shadow `SyncProvider`'s elsewhere.
    const SLOT_PATH: &str = ".meta/keyring/devices/6a37ec21-5bcc-497e-bcb0-2bffae8863c4.json";

    // Folder-find queries carry `mimeType = 'application/vnd.google-apps.folder'`
    // in `q`; the final file-by-name query does not. Splitting the two stubs on
    // that substring (folder stub registered FIRST, so FIFO routes folder
    // queries to it and the file query falls through to the second stub) lets
    // the folder walk SUCCEED and the assertion land on the *file query* — the
    // branch `resolve_shared_file_id` actually owns.
    async fn mount_folder_walk_ok(mock: &MockServer) {
        use wiremock::matchers::query_param_contains;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains(
                "q",
                "application/vnd.google-apps.folder",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "folder-id"}] })),
            )
            .mount(mock)
            .await;
    }

    #[tokio::test]
    async fn keyring_delete_file_resolves_and_deletes_device_slot() {
        let mock = MockServer::start().await;
        mount_folder_walk_ok(&mock).await;
        // File-by-name query (no folder mimeType) → resolves the slot id.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "slot-id"}] })),
            )
            .mount(&mock)
            .await;
        // DELETE the resolved file id.
        Mock::given(method("DELETE"))
            .and(path("/drive/v3/files/slot-id"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        crate::sync::keyring_v2::KeyringV2Io::delete_file(&provider, SLOT_PATH)
            .await
            .expect("delete must accept the 4-segment shared slot path");
    }

    #[tokio::test]
    async fn keyring_delete_file_is_idempotent_when_slot_absent() {
        let mock = MockServer::start().await;
        mount_folder_walk_ok(&mock).await;
        // Folder walk succeeds; the file-by-name query returns empty → the slot
        // is genuinely gone → Ok no-op.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        crate::sync::keyring_v2::KeyringV2Io::delete_file(&provider, SLOT_PATH)
            .await
            .expect("delete on an absent slot must be a no-op Ok");
    }

    /// Transient failure on the FILE query (folder walk already succeeded) must
    /// NOT be flattened to "already gone" — otherwise revoke silently leaves a
    /// live slot on the cloud. This exercises `resolve_shared_file_id`'s own
    /// 5xx branch, not `find_folder`'s.
    #[tokio::test]
    async fn keyring_delete_file_propagates_transient_error() {
        let mock = MockServer::start().await;
        mount_folder_walk_ok(&mock).await;
        // File-by-name query (no folder mimeType) returns 503.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = crate::sync::keyring_v2::KeyringV2Io::delete_file(&provider, SLOT_PATH)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "503 while resolving a slot must propagate, got {err:?}"
        );
    }

    /// 401 on the file query must surface as Auth (re-auth), not "already gone".
    #[tokio::test]
    async fn keyring_delete_file_maps_401_on_file_query_to_auth() {
        let mock = MockServer::start().await;
        mount_folder_walk_ok(&mock).await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = crate::sync::keyring_v2::KeyringV2Io::delete_file(&provider, SLOT_PATH)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "401 while resolving a slot must surface as Auth, got {err:?}"
        );
    }

    // ─── escape_drive_query / is_safe_identifier ─────────────────────────────

    #[test]
    fn escape_drive_query_escapes_single_quotes() {
        assert_eq!(escape_drive_query("a'b"), "a\\'b");
    }

    #[test]
    fn escape_drive_query_escapes_backslashes_before_quotes() {
        // Backslashes must be doubled FIRST so later single-quote escaping
        // can't be re-parsed incorrectly on the server side.
        assert_eq!(escape_drive_query("a\\b'c"), "a\\\\b\\'c");
    }

    #[test]
    fn escape_drive_query_passes_through_safe_strings() {
        assert_eq!(escape_drive_query("Memlore"), "Memlore");
        assert_eq!(
            escape_drive_query("550e8400-e29b-41d4-a716-446655440000"),
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }

    #[test]
    fn parse_drive_path_accepts_two_part_path_for_device_root_file() {
        // `{device_id}/metadata.json` → file directly in device folder.
        assert_eq!(
            parse_drive_path("dev-uuid/metadata.json").unwrap(),
            DrivePath {
                device_id: "dev-uuid",
                subfolder: None,
                filename: "metadata.json",
            }
        );
    }

    #[test]
    fn parse_drive_path_accepts_three_part_path_with_arbitrary_subfolder() {
        // `{device_id}/entries/{id}.bin` → file in device/entries subfolder.
        assert_eq!(
            parse_drive_path("dev-uuid/entries/abc123.bin").unwrap(),
            DrivePath {
                device_id: "dev-uuid",
                subfolder: Some("entries"),
                filename: "abc123.bin",
            }
        );
    }

    #[test]
    fn parse_drive_path_accepts_media_subfolder() {
        // Chunk 6 will use this shape: do not hardcode "entries".
        assert_eq!(
            parse_drive_path("dev-uuid/media/img.bin").unwrap(),
            DrivePath {
                device_id: "dev-uuid",
                subfolder: Some("media"),
                filename: "img.bin",
            }
        );
    }

    #[test]
    fn parse_drive_path_rejects_single_part_path() {
        assert!(parse_drive_path("metadata.json").is_err());
    }

    #[test]
    fn parse_drive_path_rejects_more_than_three_parts() {
        // Nested folders beyond one level are not part of the contract.
        // Pin the exact error variant + prefix so a log or UI filter that
        // keys off the wording does not silently break on a future refactor.
        let err = parse_drive_path("dev/a/b/c.bin").unwrap_err();
        match err {
            SyncError::Io(msg) => assert!(
                msg.starts_with("Invalid path:"),
                "expected \"Invalid path:\" prefix, got: {msg}"
            ),
            other => panic!("expected SyncError::Io, got {other:?}"),
        }
    }

    #[test]
    fn parse_drive_path_rejects_unsafe_components() {
        let bad_inputs = [
            "dev'id/file.json",
            "dev/sub'folder/file.bin",
            "dev/sub/fi\\le.bin",
            "/leading/slash.bin",
            "dev//empty.bin",
        ];
        for input in bad_inputs {
            assert!(
                parse_drive_path(input).is_err(),
                "parse_drive_path should reject {input:?}"
            );
        }
    }

    /// End-to-end: writing a 2-part path must upload to the device folder
    /// directly, NOT pass through an `entries/` subfolder. This locks in
    /// the fix for the "Invalid path: <uuid>/metadata.json" regression and
    /// prevents a future refactor from re-hardcoding "entries" inside
    /// `write_file`.
    #[tokio::test]
    async fn write_file_two_part_path_uploads_to_device_folder_without_entries() {
        use wiremock::matchers::{body_string_contains, query_param};

        let mock = MockServer::start().await;

        // resolve_file_id → listing inside the device folder returns empty
        // (the file does not exist yet, so write_file takes the "create"
        // branch). Any other GET /drive/v3/files returns empty files.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        // Folder creation: return a distinct ID per request body so we can
        // assert in the multipart upload which folder was used as parent.
        // The device folder creation body mentions the device id.
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .and(body_string_contains("\"name\":\"Memlore\""))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": "root-id" })),
            )
            .mount(&mock)
            .await;

        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .and(body_string_contains("\"name\":\"test-device\""))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "device-folder-id" })),
            )
            .mount(&mock)
            .await;

        // CRITICAL: no mock for `"name":"entries"` folder creation. If
        // `write_file` regresses and tries to create `entries/`, that POST
        // lands in the generic catchall below — which returns a DIFFERENT
        // id so the multipart upload's parent won't be "device-folder-id",
        // failing the final assertion.
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "UNEXPECTED-folder-creation" })),
            )
            .mount(&mock)
            .await;

        // The multipart upload endpoint asserts the parent folder is the
        // device folder, not any sub-entries folder.
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .and(query_param("uploadType", "multipart"))
            .and(body_string_contains("\"name\":\"metadata.json\""))
            .and(body_string_contains("\"parents\":[\"device-folder-id\"]"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "id": "uploaded-file-id", "name": "metadata.json" }),
            ))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        provider
            .write_file("test-device/metadata.json", b"manifest-body")
            .await
            .expect("2-part write must succeed without touching an entries/ folder");
    }

    #[test]
    fn is_safe_identifier_accepts_uuid_and_filename_patterns() {
        assert!(is_safe_identifier("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_safe_identifier("entry.bin"));
        assert!(is_safe_identifier("my_device_name"));
    }

    #[test]
    fn is_safe_identifier_rejects_quotes_and_slashes() {
        assert!(!is_safe_identifier("foo'bar"));
        assert!(!is_safe_identifier("foo\\bar"));
        assert!(!is_safe_identifier("foo/bar"));
        assert!(!is_safe_identifier("foo bar"));
        assert!(!is_safe_identifier(""));
    }

    /// Write-side dual-layout regression: flat has the file, gen miss →
    /// migrate-on-write must create (POST multipart) under gen and must
    /// **not** PATCH the legacy flat file id.
    #[tokio::test]
    async fn write_file_migrate_on_write_creates_under_gen_not_patch_flat() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use wiremock::matchers::{method as m, path as p, query_param};
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        struct MigrateOnWriteListResponder;
        impl Respond for MigrateOnWriteListResponder {
            fn respond(&self, request: &Request) -> RT {
                let path = request.url.path();
                if path == "/drive/v3/files/control-id" {
                    return RT::new(200).set_body_json(serde_json::json!({
                        "version": 1,
                        "recovery_generation": 1,
                        "recovery_lease": null,
                        "updated_at": 1,
                    }));
                }
                if path != "/drive/v3/files" {
                    return RT::new(404);
                }
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                // Fence control walk + gen write resolve (miss on file) +
                // find_or_create of gen folders. Flat file is present but
                // resolve_file_id_for_write must never reach it.
                let body = if q.contains("name = '.meta'") {
                    serde_json::json!({ "files": [{"id": "meta-id"}] })
                } else if q.contains("name = 'control.json'") {
                    serde_json::json!({ "files": [{"id": "control-id"}] })
                } else if q.contains("name = 'generations'") {
                    serde_json::json!({ "files": [{"id": "generations-id"}] })
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!({ "files": [{"id": "g1-id"}] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'g1-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'gen-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "gen-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'gen-media-id' in parents") {
                    // Gen miss — write must create, not update.
                    serde_json::json!({ "files": [] })
                } else if q.contains("name = 'dev-uuid'") && q.contains("'root-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-dev-id"}] })
                } else if q.contains("name = 'media'") && q.contains("'flat-dev-id' in parents") {
                    serde_json::json!({ "files": [{"id": "flat-media-id"}] })
                } else if q.contains("name = 'abc123'") && q.contains("'flat-media-id' in parents")
                {
                    // Flat has the payload — dual-read would find this, write
                    // must not PATCH it.
                    serde_json::json!({ "files": [{"id": "flat-file-id"}] })
                } else {
                    serde_json::json!({ "files": [] })
                };
                RT::new(200).set_body_json(body)
            }
        }

        let multipart_seen = Arc::new(AtomicBool::new(false));
        let multipart_flag = Arc::clone(&multipart_seen);

        struct MultipartCreateResponder {
            seen: Arc<AtomicBool>,
        }
        impl Respond for MultipartCreateResponder {
            fn respond(&self, request: &Request) -> RT {
                // Multipart body must name the file and parent under gen media.
                let body = String::from_utf8_lossy(&request.body);
                assert!(
                    body.contains("\"name\":\"abc123\""),
                    "create must name the file abc123"
                );
                assert!(
                    body.contains("\"parents\":[\"gen-media-id\"]"),
                    "create must parent under gen media, not flat; body={body}"
                );
                assert!(
                    !body.contains("flat-file-id") && !body.contains("flat-media-id"),
                    "create must not reference flat layout ids"
                );
                self.seen.store(true, Ordering::SeqCst);
                RT::new(200).set_body_json(serde_json::json!({ "id": "new-gen-file-id" }))
            }
        }

        let mock = MockServer::start().await;
        Mock::given(m("GET"))
            .respond_with(MigrateOnWriteListResponder)
            .mount(&mock)
            .await;
        // Critical: never PATCH the flat orphan id (or any other file).
        Mock::given(m("PATCH"))
            .and(p("/drive/v3/files/flat-file-id"))
            .respond_with(RT::new(500))
            .expect(0)
            .mount(&mock)
            .await;
        Mock::given(m("PATCH"))
            .respond_with(RT::new(500))
            .expect(0)
            .mount(&mock)
            .await;
        Mock::given(m("POST"))
            .and(p("/drive/v3/files"))
            .and(query_param("uploadType", "multipart"))
            .respond_with(MultipartCreateResponder {
                seen: multipart_flag,
            })
            .expect(1)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        provider
            .write_file("dev-uuid/media/abc123", b"migrated-bytes")
            .await
            .expect("migrate-on-write create under gen must succeed");
        assert!(
            multipart_seen.load(Ordering::SeqCst),
            "must POST multipart create under gen when gen misses and flat has the file"
        );
    }

    #[tokio::test]
    async fn write_file_rejects_path_with_single_quote() {
        let mock = MockServer::start().await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // Malicious device_id attempting q= injection.
        let err = provider
            .write_file("evil'device/entries/file.bin", b"data")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Io(_)),
            "quote in path must be rejected, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn write_file_rejects_path_with_backslash() {
        let mock = MockServer::start().await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let err = provider
            .write_file("dev/entries/evil\\name.bin", b"data")
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::Io(_)));
    }

    // ─── ensure_folder_structure ─────────────────────────────────────────────

    #[tokio::test]
    async fn ensure_folder_structure_creates_hierarchy() {
        let mock = MockServer::start().await;

        // All list calls return empty (folder doesn't exist yet).
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        // All create calls succeed and return a fake ID.
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "new-folder-id" })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let root_id = provider
            .ensure_folder_structure("test-device")
            .await
            .unwrap();
        assert_eq!(root_id, "new-folder-id");

        // Verify root_folder_id was cached.
        let cached = provider.root_folder_id.read().await.clone();
        assert!(cached.is_some());
    }

    #[tokio::test]
    async fn ensure_folder_structure_is_idempotent() {
        let mock = MockServer::start().await;

        // All list calls return existing folders.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "existing-id"}] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // Call twice — should not fail on second call.
        provider.ensure_folder_structure("dev-a").await.unwrap();
        provider.ensure_folder_structure("dev-a").await.unwrap();
    }

    // ─── parse_shared_path ───────────────────────────────────────────────────

    #[test]
    fn parse_shared_path_accepts_v1_meta_keyring() {
        let result = parse_shared_path(".meta/keyring.json").unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(subfolder_path, vec![".meta".to_string()]);
        assert_eq!(filename, "keyring.json");
    }

    #[test]
    fn parse_shared_path_accepts_recovery_marker() {
        let result = parse_shared_path(".meta/_recovery_marker.json").unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(subfolder_path, vec![".meta".to_string()]);
        assert_eq!(filename, "_recovery_marker.json");
    }

    #[test]
    fn parse_shared_path_accepts_sync_control() {
        let result = parse_shared_path(".meta/control.json").unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(subfolder_path, vec![".meta".to_string()]);
        assert_eq!(filename, "control.json");
    }

    #[test]
    fn cloud_cleanup_preserves_only_root_meta_and_control_authority() {
        assert!(preserve_during_cloud_cleanup("root", ".meta"));
        assert!(preserve_during_cloud_cleanup(".meta", "control.json"));
        // Live fence marker is control authority — must survive payload wipe.
        assert!(preserve_during_cloud_cleanup(
            ".meta",
            "_recovery_marker.json"
        ));
        for payload in ["generations", "dev-a", "mode.json", "keyring"] {
            assert!(!preserve_during_cloud_cleanup(".meta", payload));
            assert!(!preserve_during_cloud_cleanup("root", payload));
        }
    }

    #[test]
    fn cloud_cleanup_accepts_unchanged_generation_zero_and_positive_authority() {
        for generation in [0, 7] {
            let control = crate::sync::sync_control::SyncControlV1 {
                version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
                recovery_generation: generation,
                recovery_lease: None,
                updated_at: 10,
            };
            assert!(verify_cleanup_preserved_control(&control, &control).is_ok());
        }
    }

    #[test]
    fn cloud_cleanup_fails_closed_when_lease_appears_mid_delete() {
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};

        let before = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: 1,
            recovery_lease: None,
            updated_at: 10,
        };
        let mid_with_lease = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: 2,
            recovery_lease: Some(RecoveryMarker {
                version: RECOVERY_MARKER_VERSION,
                job_id: 9,
                owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
                operation: "local_to_cloud".to_string(),
                recovery_generation: 2,
                nonce: "0123456789abcdef".to_string(),
                created_at: 1,
                updated_at: 11,
            }),
            updated_at: 11,
        };
        let err = verify_cleanup_preserved_control(&before, &mid_with_lease).unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "lease mid-delete must fail closed as Auth, got {err:?}"
        );
    }

    #[test]
    fn cloud_cleanup_fails_closed_when_generation_bumps_mid_delete() {
        let before = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: 1,
            recovery_lease: None,
            updated_at: 10,
        };
        let mid = crate::sync::sync_control::SyncControlV1 {
            recovery_generation: 2,
            updated_at: 11,
            ..before.clone()
        };
        assert!(verify_cleanup_preserved_control(&before, &mid).is_err());
    }

    #[test]
    fn provider_generation_namespace_is_bound_per_writer() {
        let first = GDriveProvider::new(
            make_session("tok"),
            "http://127.0.0.1:1",
            "http://127.0.0.1:1",
        )
        .unwrap()
        .with_recovery_fence(3, None);
        let delayed = GDriveProvider::new(
            make_session("tok"),
            "http://127.0.0.1:1",
            "http://127.0.0.1:1",
        )
        .unwrap()
        .with_recovery_fence(2, None);

        assert_eq!(first.generation_folder_name(), "g-3");
        assert_eq!(delayed.generation_folder_name(), "g-2");
        assert_ne!(
            first.generation_folder_name(),
            delayed.generation_folder_name()
        );
    }

    #[tokio::test]
    async fn generic_keyring_mutations_cannot_touch_recovery_authority() {
        use crate::sync::keyring_v2::KeyringV2Io;

        let provider = GDriveProvider::new(
            make_session("tok"),
            "http://127.0.0.1:1",
            "http://127.0.0.1:1",
        )
        .unwrap();

        assert!(
            KeyringV2Io::write_file(&provider, ".meta/control.json", b"{}")
                .await
                .is_err()
        );
        assert!(
            KeyringV2Io::delete_file(&provider, ".meta/_recovery_marker.json")
                .await
                .is_err()
        );
    }

    async fn mount_shared_exact_file_resolution(
        mock: &MockServer,
        filename: &str,
        file_ids: serde_json::Value,
    ) {
        use wiremock::matchers::query_param_contains;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"files": [{"id": "meta-folder"}]})),
            )
            .mount(mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", filename))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"files": file_ids})),
            )
            .mount(mock)
            .await;
    }

    #[tokio::test]
    async fn conditional_control_update_sends_if_match_and_maps_412_to_conflict() {
        use crate::sync::keyring_v2::{ConditionalMutationResult, KeyringV2Io};
        use wiremock::matchers::header;

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "control.json",
            serde_json::json!([{"id": "control-id"}]),
        )
        .await;
        Mock::given(method("PATCH"))
            .and(path("/drive/v3/files/control-id"))
            .and(header("if-match", "etag-7"))
            .respond_with(ResponseTemplate::new(412))
            .expect(1)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let result =
            KeyringV2Io::compare_and_swap_file(&provider, ".meta/control.json", "etag-7", b"{}")
                .await
                .unwrap();
        assert_eq!(result, ConditionalMutationResult::Conflict);
    }

    #[tokio::test]
    async fn conditional_control_create_reconciles_duplicate_race_to_one_winner() {
        use crate::sync::keyring_v2::{ConditionalMutationResult, KeyringV2Io};
        use wiremock::matchers::{query_param, query_param_contains};

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"files": [{"id": "meta-folder"}]})),
            )
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "control.json"))
            .and(query_param("fields", "files(id,createdTime)"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"files": []})),
            )
            .up_to_n_times(1)
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "control.json"))
            .and(query_param("fields", "files(id,createdTime)"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    {"id": "control-b", "createdTime": "2026-01-02T00:00:00Z"},
                    {"id": "control-a", "createdTime": "2026-01-01T00:00:00Z"}
                ]
            })))
            .expect(1)
            .mount(&mock)
            .await;
        let control = crate::sync::sync_control::SyncControlV1::initial(10);
        let bytes = serde_json::to_vec_pretty(&control).unwrap();
        for id in ["control-a", "control-b"] {
            Mock::given(method("GET"))
                .and(path(format!("/drive/v3/files/{id}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
                .expect(1)
                .mount(&mock)
                .await;
        }
        Mock::given(method("DELETE"))
            .and(path("/drive/v3/files/control-b"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());
        let result = KeyringV2Io::create_initial_control_if_absent(&provider, &bytes)
            .await
            .unwrap();

        assert_eq!(result, ConditionalMutationResult::Applied);
    }

    #[tokio::test]
    async fn versioned_control_read_falls_back_to_content_hash_when_drive_omits_etag_and_version() {
        use crate::sync::keyring_v2::KeyringV2Io;
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "control.json",
            serde_json::json!([{"id": "control-id"}]),
        )
        .await;
        // Media body without HTTP ETag header (real Drive behavior).
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("alt", "media"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"{}"))
            .expect(1)
            .mount(&mock)
            .await;
        // Metadata has neither ETag header nor version → content sha256.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("fields", "version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let versioned = KeyringV2Io::read_versioned_file(&provider, ".meta/control.json")
            .await
            .unwrap();
        assert_eq!(versioned.bytes, b"{}");
        assert_eq!(versioned.revision, content_sha256_revision(b"{}"));
        assert!(versioned.revision.starts_with("sha256:"));
    }

    #[tokio::test]
    async fn versioned_control_read_falls_back_to_drive_version_when_etag_absent() {
        use crate::sync::keyring_v2::KeyringV2Io;
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "control.json",
            serde_json::json!([{"id": "control-id"}]),
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("alt", "media"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"{\"v\":1}"))
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("fields", "version"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"version": "42"})),
            )
            .expect(1)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let versioned = KeyringV2Io::read_versioned_file(&provider, ".meta/control.json")
            .await
            .unwrap();
        assert_eq!(versioned.bytes, br#"{"v":1}"#);
        assert_eq!(versioned.revision, "drive-version:42");
    }

    #[tokio::test]
    async fn versioned_control_read_falls_back_to_metadata_etag_when_media_omits_header() {
        use crate::sync::keyring_v2::KeyringV2Io;
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "control.json",
            serde_json::json!([{"id": "control-id"}]),
        )
        .await;
        // Real Drive often returns alt=media without an ETag header.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("alt", "media"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"{\"v\":1}"))
            .expect(1)
            .mount(&mock)
            .await;
        // Metadata may still carry ETag on the response header.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("fields", "version"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", "\"meta-etag-9\"")
                    .set_body_json(serde_json::json!({"version": "7"})),
            )
            .expect(1)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let versioned = KeyringV2Io::read_versioned_file(&provider, ".meta/control.json")
            .await
            .unwrap();
        assert_eq!(versioned.bytes, br#"{"v":1}"#);
        assert_eq!(versioned.revision, "\"meta-etag-9\"");
    }

    #[tokio::test]
    async fn conditional_control_update_with_content_hash_skips_if_match() {
        use crate::sync::keyring_v2::{ConditionalMutationResult, KeyringV2Io};
        use wiremock::matchers::{header, query_param};

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "control.json",
            serde_json::json!([{"id": "control-id"}]),
        )
        .await;
        let body = br#"{"version":1}"#;
        let rev = content_sha256_revision(body);
        // Precondition content read (no If-Match).
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("alt", "media"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.as_slice()))
            .expect(1)
            .mount(&mock)
            .await;
        // PATCH must NOT send If-Match for synthetic revisions.
        Mock::given(method("PATCH"))
            .and(path("/drive/v3/files/control-id"))
            .and(query_param("uploadType", "media"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "control-id"})),
            )
            .expect(1)
            .mount(&mock)
            .await;
        // Fail the test if If-Match is incorrectly sent with a synthetic rev.
        Mock::given(method("PATCH"))
            .and(header("if-match", rev.as_str()))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let result = KeyringV2Io::compare_and_swap_file(
            &provider,
            ".meta/control.json",
            &rev,
            br#"{"version":2}"#,
        )
        .await
        .unwrap();
        assert_eq!(result, ConditionalMutationResult::Applied);
    }

    #[tokio::test]
    async fn duplicate_sync_control_file_ids_select_earliest_canonical_authority() {
        use crate::sync::keyring_v2::KeyringV2Io;
        use wiremock::matchers::header;

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "control.json",
            serde_json::json!([
                {"id": "control-b", "createdTime": "2026-01-02T00:00:00Z"},
                {"id": "control-a", "createdTime": "2026-01-01T00:00:00Z"}
            ]),
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-a"))
            .and(header("authorization", "Bearer tok"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", "etag-a")
                    .set_body_bytes(b"canonical"),
            )
            .expect(1)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-b"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let versioned = KeyringV2Io::read_versioned_file(&provider, ".meta/control.json")
            .await
            .unwrap();
        assert_eq!(versioned.bytes, b"canonical");
        assert_eq!(versioned.revision, "etag-a");
    }

    #[tokio::test]
    async fn conditional_marker_delete_sends_if_match() {
        use crate::sync::keyring_v2::{ConditionalMutationResult, KeyringV2Io};
        use wiremock::matchers::header;

        let mock = MockServer::start().await;
        mount_shared_exact_file_resolution(
            &mock,
            "_recovery_marker.json",
            serde_json::json!([{"id": "marker-id"}]),
        )
        .await;
        Mock::given(method("DELETE"))
            .and(path("/drive/v3/files/marker-id"))
            .and(header("if-match", "etag-marker"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let result = KeyringV2Io::delete_file_if_revision(
            &provider,
            ".meta/_recovery_marker.json",
            "etag-marker",
        )
        .await
        .unwrap();
        assert_eq!(result, ConditionalMutationResult::Applied);
    }

    #[tokio::test]
    async fn recovery_marker_gdrive_dedicated_create_and_read() {
        use crate::sync::keyring_v2::{
            read_recovery_marker, ConditionalMutationResult, KeyringV2Io, RecoveryMarker,
            RECOVERY_MARKER_VERSION,
        };
        use wiremock::matchers::{query_param, query_param_contains};

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-folder"}] })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "_recovery_marker.json"))
            .and(query_param("fields", "files(id)"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .up_to_n_times(2)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "_recovery_marker.json"))
            .and(query_param("fields", "files(id,createdTime)"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "marker-id", "createdTime": "2026-01-01T00:00:00Z"}] })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "_recovery_marker.json"))
            .and(query_param("fields", "files(id)"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "marker-id"}] })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&mock)
            .await;

        let marker = RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 1,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "control.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "control-id"}] })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                crate::sync::sync_control::SyncControlV1 {
                    version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
                    recovery_generation: marker.recovery_generation,
                    recovery_lease: Some(marker.clone()),
                    updated_at: marker.updated_at,
                },
            ))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/marker-id"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&marker))
            .expect(2)
            .mount(&mock)
            .await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());
        assert!(read_recovery_marker(&provider).await.unwrap().is_none());
        let permit = crate::sync::recovery::RecoveryOwnerPermit {
            job_id: marker.job_id,
            owner_device_id: marker.owner_device_id.clone(),
            operation: marker.operation.clone(),
            recovery_generation: marker.recovery_generation,
            nonce: marker.nonce.clone(),
        };
        let created = KeyringV2Io::create_recovery_marker_if_absent(
            &provider,
            &serde_json::to_vec(&marker).unwrap(),
            &permit,
        )
        .await
        .unwrap();
        assert_eq!(created, ConditionalMutationResult::Applied);
        assert_eq!(read_recovery_marker(&provider).await.unwrap(), Some(marker));
    }

    async fn mount_recovery_fence_reads(
        mock: &MockServer,
        marker: Option<crate::sync::keyring_v2::RecoveryMarker>,
        cloud_generation: u64,
    ) {
        use wiremock::matchers::query_param_contains;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "folder-id"}] })),
            )
            .mount(mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "control.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "control-id"}] })),
            )
            .mount(mock)
            .await;
        let control = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: cloud_generation,
            recovery_lease: marker,
            updated_at: 1,
        };
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .respond_with(ResponseTemplate::new(200).set_body_json(control))
            .mount(mock)
            .await;
        for verb in ["POST", "PATCH", "DELETE"] {
            Mock::given(method(verb))
                .respond_with(ResponseTemplate::new(500))
                .expect(0)
                .mount(mock)
                .await;
        }
    }

    #[tokio::test]
    async fn mutation_boundary_blocks_active_recovery_marker_before_http_write() {
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};
        let mock = MockServer::start().await;
        let marker = RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 2,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        mount_recovery_fence_reads(&mock, Some(marker), 2).await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());
        assert!(provider
            .write_file("dev-a/entries/e.bin", b"blocked")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn active_recovery_marker_blocks_ensure_folder_creation_posts() {
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};
        let mock = MockServer::start().await;
        let marker = RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 2,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        mount_recovery_fence_reads(&mock, Some(marker), 2).await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);

        assert!(provider.ensure_folder_structure("dev-a").await.is_err());
    }

    #[tokio::test]
    async fn mutation_boundary_blocks_generation_mismatch_before_http_write() {
        let mock = MockServer::start().await;
        mount_recovery_fence_reads(&mock, None, 2).await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());
        assert!(provider
            .write_file("dev-a/entries/e.bin", b"blocked")
            .await
            .is_err());
    }

    /// A live recovery marker owned by a *different* job/owner (a foreign or
    /// stale recovery attempt's permit) must not pass the mutation gate, even
    /// though this provider does carry *some* permit. `authorize_recovery_push`
    /// requires every field (job_id, owner_device_id, operation, generation,
    /// nonce) to match the cloud marker exactly — verify that end-to-end
    /// through the provider boundary, and that rejection happens before any
    /// HTTP write (reusing `mount_recovery_fence_reads`'s `expect(0)` guards
    /// on POST/PATCH/DELETE).
    #[tokio::test]
    async fn mutation_boundary_blocks_mismatched_recovery_owner_permit_before_http_write() {
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};
        use crate::sync::recovery::RecoveryOwnerPermit;

        let mock = MockServer::start().await;
        let marker = RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 2,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        mount_recovery_fence_reads(&mock, Some(marker.clone()), 2).await;

        // A permit for a different job/owner entirely — e.g. a foreign
        // device's stale recovery attempt — must not be accepted as this
        // marker's owner.
        let foreign_permit = RecoveryOwnerPermit {
            job_id: 999,
            owner_device_id: "zzzzzzzz-9999-9999-9999-zzzzzzzzzzzz".to_string(),
            operation: marker.operation.clone(),
            recovery_generation: marker.recovery_generation,
            nonce: marker.nonce.clone(),
        };
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(2, Some(foreign_permit));
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        assert!(provider
            .write_file("dev-a/entries/e.bin", b"blocked")
            .await
            .is_err());
    }

    /// The mirror image of the rejection tests above: a permit whose every
    /// field matches the live cloud marker exactly (this device *is* the
    /// recovery job's owner) must pass the fence and let the mutation
    /// proceed to the actual Drive write.
    #[tokio::test]
    async fn mutation_boundary_allows_matching_recovery_owner_permit() {
        use crate::sync::keyring_v2::{RecoveryMarker, RECOVERY_MARKER_VERSION};
        use crate::sync::recovery::RecoveryOwnerPermit;
        use wiremock::{Request, Respond, ResponseTemplate as RT};

        /// Routes every GET to the control.json lookup when the query asks
        /// for it, and otherwise pretends any folder/file already exists at
        /// a single stable id — good enough for `write_file` to resolve its
        /// parent chain and then PATCH-update that same id, without needing
        /// to model every intermediate folder separately.
        struct OwnerPassResponder;
        impl Respond for OwnerPassResponder {
            fn respond(&self, request: &Request) -> RT {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default();
                if q.contains("control.json") {
                    return RT::new(200)
                        .set_body_json(serde_json::json!({ "files": [{"id": "control-id"}] }));
                }
                RT::new(200).set_body_json(serde_json::json!({ "files": [{"id": "folder-id"}] }))
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(OwnerPassResponder)
            .mount(&mock)
            .await;

        let marker = RecoveryMarker {
            version: RECOVERY_MARKER_VERSION,
            job_id: 1,
            owner_device_id: "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb".to_string(),
            operation: "local_to_cloud".to_string(),
            recovery_generation: 2,
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        let control = crate::sync::sync_control::SyncControlV1 {
            version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
            recovery_generation: 2,
            recovery_lease: Some(marker.clone()),
            updated_at: 1,
        };
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/control-id"))
            .respond_with(ResponseTemplate::new(200).set_body_json(control))
            .mount(&mock)
            .await;
        Mock::given(method("PATCH"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "folder-id", "name": "e.bin" })),
            )
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "written-id", "name": "e.bin" })),
            )
            .mount(&mock)
            .await;

        let permit = RecoveryOwnerPermit {
            job_id: marker.job_id,
            owner_device_id: marker.owner_device_id.clone(),
            operation: marker.operation.clone(),
            recovery_generation: marker.recovery_generation,
            nonce: marker.nonce.clone(),
        };
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(2, Some(permit));
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        provider
            .write_file("dev-a/entries/e.bin", b"allowed")
            .await
            .expect("matching recovery owner permit must pass the fence and proceed to write");
    }

    #[test]
    fn parse_shared_path_accepts_v2_keyring_meta() {
        // V2 root meta file lives one folder deeper than V1.
        let result = parse_shared_path(".meta/keyring/_meta.json").unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(
            subfolder_path,
            vec![".meta".to_string(), "keyring".to_string()]
        );
        assert_eq!(filename, "_meta.json");
    }

    #[test]
    fn parse_shared_path_accepts_v2_recovery_slot() {
        let result = parse_shared_path(".meta/keyring/_recovery.json").unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(
            subfolder_path,
            vec![".meta".to_string(), "keyring".to_string()]
        );
        assert_eq!(filename, "_recovery.json");
    }

    #[test]
    fn parse_shared_path_accepts_v2_content_list() {
        // `_content.json` (content-key DEK list, added with the Phase 2
        // content-key work) is a legitimate keyring file written by
        // `publish_v2_keyring_with_provider`. It must be in the allow-list or
        // every keyring (re)publish fails with "Shared path not in allow-list".
        let result = parse_shared_path(".meta/keyring/_content.json").unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(
            subfolder_path,
            vec![".meta".to_string(), "keyring".to_string()]
        );
        assert_eq!(filename, "_content.json");
    }

    #[test]
    fn parse_shared_path_accepts_v2_device_slot() {
        // Device slot files use dynamic UUID names; they must be accepted
        // by the prefix/suffix matcher.
        let result =
            parse_shared_path(".meta/keyring/devices/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json")
                .unwrap();
        let SharedDrivePath::MetaFile {
            subfolder_path,
            filename,
        } = result;
        assert_eq!(
            subfolder_path,
            vec![
                ".meta".to_string(),
                "keyring".to_string(),
                "devices".to_string()
            ]
        );
        assert_eq!(filename, "a1b2c3d4-e5f6-7890-abcd-ef1234567890.json");
    }

    #[test]
    fn parse_shared_path_rejects_v2_device_slot_without_json_suffix() {
        // Non-JSON files under devices/ are not in the allow-list.
        assert!(parse_shared_path(".meta/keyring/devices/foo.bin").is_err());
    }

    #[test]
    fn parse_shared_path_rejects_v2_device_slot_with_nested_path() {
        // Slot files are flat — no nested directories under devices/.
        assert!(parse_shared_path(".meta/keyring/devices/inner/foo.json").is_err());
    }

    #[test]
    fn parse_shared_path_rejects_root_level_file() {
        assert!(parse_shared_path("keyring.json").is_err());
    }

    #[test]
    fn parse_shared_path_rejects_path_traversal() {
        assert!(parse_shared_path("../../etc/passwd").is_err());
    }

    #[test]
    fn parse_shared_path_rejects_arbitrary_meta_file() {
        // Not in the allow-list even though shape is correct.
        assert!(parse_shared_path(".meta/evil.sh").is_err());
    }

    #[test]
    fn parse_shared_path_rejects_device_envelope_path() {
        // Device-scoped entry envelope — handled by parse_drive_path, NOT
        // parse_shared_path. The leading segment is a device UUID, not `.meta`,
        // so it falls outside both allow-list forms.
        assert!(parse_shared_path("device-abc/entries/foo.bin").is_err());
    }

    // ─── read_shared_file ────────────────────────────────────────────────────

    #[tokio::test]
    async fn read_shared_file_returns_not_found_when_root_missing() {
        let mock = MockServer::start().await;
        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // root_folder_id is None — no Drive API calls should be made.
        let err = provider
            .read_shared_file(".meta/keyring.json")
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));
    }

    #[tokio::test]
    async fn read_shared_file_returns_bytes_for_existing_file() {
        let mock = MockServer::start().await;
        // Both the folder-find and file-find calls go to /drive/v3/files
        // and both return the same id — using a single mock is sufficient here.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "shared-id"}] })),
            )
            .mount(&mock)
            .await;
        // Download call goes to /drive/v3/files/shared-id?alt=media.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/shared-id"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"keyring-content".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let bytes = provider
            .read_shared_file(".meta/keyring.json")
            .await
            .unwrap();
        assert_eq!(bytes, b"keyring-content");
    }

    // ─── write_shared_file ───────────────────────────────────────────────────

    #[tokio::test]
    async fn write_shared_file_patches_existing_file() {
        use wiremock::matchers::method as m;
        let mock = MockServer::start().await;
        // Both folder-find and file-find return the same id.
        Mock::given(m("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "fileobj-id"}] })),
            )
            .mount(&mock)
            .await;
        // PATCH to update the existing file.
        Mock::given(m("PATCH"))
            .and(path("/drive/v3/files/fileobj-id"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        provider
            .write_shared_file(".meta/keyring.json", b"updated-content")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn write_shared_file_creates_new_file_via_multipart() {
        use wiremock::matchers::{method as m, query_param};
        let mock = MockServer::start().await;
        // WireMock uses FIFO: the first registered mock is matched first.
        // Call 1 (find ".meta" folder) → consumed, returns meta-id.
        Mock::given(m("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-id"}] })),
            )
            .up_to_n_times(1)
            .mount(&mock)
            .await;
        // Call 2 (check if file exists) → returns empty → file absent.
        Mock::given(m("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;
        // Multipart POST creates the new file.
        Mock::given(m("POST"))
            .and(path("/drive/v3/files"))
            .and(query_param("uploadType", "multipart"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "new-file-id" })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        provider
            .write_shared_file(".meta/keyring.json", b"new-content")
            .await
            .unwrap();
    }

    // ─── appDataFolder migration assertions ─────────────────────────────────
    //
    // Phase 2 of the appdata migration swapped every `spaces=drive` query and
    // every `"root"` parent literal to `appDataFolder`. These tests pin the
    // wire-level behaviour so a regression cannot silently revert to the
    // legacy My-Drive-visible folder.

    #[tokio::test]
    async fn ensure_folder_structure_creates_memlore_inside_appdata() {
        use wiremock::matchers::{body_string_contains, query_param};

        let mock = MockServer::start().await;

        // STRICT list mock: ONLY responds to GETs that carry
        // `spaces=appDataFolder`. A regression to `spaces=drive` falls
        // through to the catchall 404, breaking the test — that's the
        // whole point.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        // The Memlore root folder must be created with
        // `"parents":["appDataFolder"]`, NOT `"root"`. Split into two
        // body_string_contains calls so the assertion survives minor
        // serde_json formatting tweaks (e.g. whitespace introduction).
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .and(body_string_contains("\"name\":\"Memlore\""))
            .and(body_string_contains("\"parents\""))
            .and(body_string_contains("\"appDataFolder\""))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "root-inside-appdata" })),
            )
            .mount(&mock)
            .await;

        // Subfolder creations (device, entries, media) use the parent
        // folder ID — no special assertion needed.
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "sub-folder-id" })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let root_id = provider
            .ensure_folder_structure("test-device")
            .await
            .unwrap();
        assert_eq!(root_id, "root-inside-appdata");
    }

    #[tokio::test]
    async fn find_canonical_root_folder_uses_spaces_appdata_folder() {
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;

        // Strict mock: ONLY responds to list calls that carry
        // `spaces=appDataFolder`. Any regression to `spaces=drive` falls
        // through to the catchall 404 and the test fails.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "existing-root", "createdTime": "2026-05-23T00:00:00Z"}] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let root = provider.ensure_root_folder_id_for_read().await.unwrap();
        assert_eq!(root.as_deref(), Some("existing-root"));
    }

    #[tokio::test]
    async fn list_devices_uses_spaces_appdata_folder() {
        // `list_devices` makes TWO GETs: the lazy root discovery call
        // (`find_canonical_root_folder`) and the inline subfolder listing.
        // Both must carry `spaces=appDataFolder`. Strict mock catches a
        // regression in either site.
        //
        // The response carries `id`, `createdTime`, AND `name` so it
        // deserialises cleanly under both shapes
        // (`Fi { id, createdTime }` in root discovery and `Fi { name }`
        // in the inline subfolder listing). Extra fields are tolerated.
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "files": [{"id": "root-id", "createdTime": "2026-05-23T00:00:00Z", "name": "device-a"}]
                })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // Assert non-empty result: a `spaces=drive` regression falls
        // through to the 404 catchall, `find_canonical_root_folder`
        // degrades to `Ok(None)`, and `list_devices` early-returns
        // `Ok(vec![])`. The `.unwrap()` alone would succeed silently —
        // pinning the expected device name is what actually catches the
        // regression.
        let devices = provider.list_devices().await.unwrap();
        assert_eq!(devices, vec!["device-a".to_string()]);
    }

    #[tokio::test]
    async fn list_files_uses_spaces_appdata_folder() {
        // `list_files` walks: root lookup → device folder lookup → subfolder
        // lookup → file listing. All four GETs must carry
        // `spaces=appDataFolder`. Strict mock catches any regression in
        // `find_folder` or the inline file-list query.
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "files": [{"id": "found-id", "createdTime": "2026-05-23T00:00:00Z", "name": "found"}]
                })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // FileKind::Entries exercises the `entries/` subfolder traversal.
        // Assert non-empty result so a `spaces=drive` regression — which
        // would fall through to the 404 catchall and yield `Ok(vec![])` —
        // fails this test instead of passing silently.
        let files = provider
            .list_files("test-device", FileKind::Entries)
            .await
            .unwrap();
        assert_eq!(files, vec!["test-device/entries/found".to_string()]);
    }

    #[tokio::test]
    async fn read_shared_file_uses_spaces_appdata_folder() {
        // The shared-keyring read path also walks `find_folder` for the
        // `.meta` subfolder and the inline file-name query. Both must
        // carry `spaces=appDataFolder`.
        use wiremock::matchers::query_param;

        let mock = MockServer::start().await;

        // Strict list mock — every list goes through appdata or fails.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [{"id": "kr-id", "createdTime": "2026-05-23T00:00:00Z", "name": "kr"}]
            })))
            .mount(&mock)
            .await;

        // Final content download is by file-id, no spaces param involved.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/kr-id"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"keyring-bytes".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let bytes = provider
            .read_shared_file(".meta/keyring.json")
            .await
            .unwrap();
        assert_eq!(bytes, b"keyring-bytes");
    }

    #[tokio::test]
    async fn find_canonical_root_folder_queries_appdata_parent() {
        use wiremock::matchers::{query_param, query_param_contains};

        let mock = MockServer::start().await;

        // The `q=` parameter for the canonical-root lookup MUST include
        // `'appDataFolder' in parents` (not `'root' in parents`). The
        // value is percent-encoded in the URL — the substring matcher
        // checks the encoded form contains `appDataFolder`.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param("spaces", "appDataFolder"))
            .and(query_param_contains("q", "appDataFolder"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let token = provider.ensure_fresh_token().await.unwrap();
        let result = provider.find_canonical_root_folder(&token).await.unwrap();
        assert!(result.is_none(), "no Memlore folder yet — got {result:?}");
    }

    #[tokio::test]
    async fn find_canonical_root_folder_surfaces_scope_mismatch_on_403_insufficient_scopes() {
        let mock = MockServer::start().await;

        // Drive returns 403 with a JSON body that names the
        // `insufficientScopes` reason when a `drive.file`-scoped token
        // asks about `spaces=appDataFolder`. The provider must surface
        // this as `SyncError::ScopeMismatch` so the engine can drive
        // the migration UX.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "error": {
                    "errors": [{
                        "domain": "global",
                        "reason": "insufficientScopes",
                        "message": "Insufficient Permission"
                    }],
                    "code": 403,
                    "message": "Insufficient Permission"
                }
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let token = provider.ensure_fresh_token().await.unwrap();
        let err = provider
            .find_canonical_root_folder(&token)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::ScopeMismatch(_)),
            "expected ScopeMismatch, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn find_canonical_root_folder_treats_unrelated_403_as_no_folder() {
        // A 403 for a non-scope reason (e.g. rate-limit-exceeded) must
        // NOT trigger the migration UX — it falls back to "no root
        // visible" so the next sync retries normally.
        let mock = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "error": {
                    "errors": [{
                        "domain": "usageLimits",
                        "reason": "rateLimitExceeded",
                        "message": "Rate Limit Exceeded"
                    }],
                    "code": 403,
                    "message": "Rate Limit Exceeded"
                }
            })))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let token = provider.ensure_fresh_token().await.unwrap();
        let result = provider.find_canonical_root_folder(&token).await.unwrap();
        assert!(result.is_none());
    }

    // ─── classify_list_status unit tests ─────────────────────────────────────
    //
    // These test the pure status-classification helper in isolation. The helper
    // is the testable seam because full HTTP mocking per status is the only
    // other option, and these are cheaper and more exhaustive.

    #[test]
    fn classify_list_status_ok_on_200() {
        assert!(classify_list_status(reqwest::StatusCode::OK).is_ok());
    }

    #[test]
    fn classify_list_status_auth_on_401() {
        let err = classify_list_status(reqwest::StatusCode::UNAUTHORIZED).unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "401 must map to Auth, got {err:?}"
        );
    }

    #[test]
    fn classify_list_status_network_on_403() {
        let err = classify_list_status(reqwest::StatusCode::FORBIDDEN).unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "403 must map to Network (transient quota), got {err:?}"
        );
    }

    #[test]
    fn classify_list_status_network_on_429() {
        let err = classify_list_status(reqwest::StatusCode::TOO_MANY_REQUESTS).unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "429 must map to Network, got {err:?}"
        );
    }

    #[test]
    fn classify_list_status_network_on_500() {
        let err = classify_list_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR).unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "500 must map to Network, got {err:?}"
        );
    }

    #[test]
    fn classify_list_status_network_on_503() {
        let err = classify_list_status(reqwest::StatusCode::SERVICE_UNAVAILABLE).unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "503 must map to Network, got {err:?}"
        );
    }

    #[test]
    fn classify_list_status_network_on_404() {
        // Fail-closed: an unexpected 404 from a list endpoint should propagate,
        // not be silently treated as "folder is empty". Only a 2xx with an empty
        // files array means genuinely absent.
        let err = classify_list_status(reqwest::StatusCode::NOT_FOUND).unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "404 from a list call must map to Network (fail-closed), got {err:?}"
        );
    }

    // ─── list_files fail-closed behavioral tests ──────────────────────────────

    #[tokio::test]
    async fn list_files_returns_auth_error_on_401_from_file_listing() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder queries contain `mimeType = 'application/...` (equals, not !=).
        // The file-listing query has `mimeType !=` so this more specific
        // substring avoids matching it.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType = 'application"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "folder-id"}] })),
            )
            .mount(&mock)
            .await;
        // The file-listing query (`mimeType !=`) falls through to this 401.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .list_files("dev-id", FileKind::Entries)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "401 on file listing must propagate as Auth, got {err:?}"
        );
    }

    #[tokio::test]
    async fn list_files_returns_network_error_on_503_from_file_listing() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder queries have `mimeType = '...'`; file-listing has `mimeType !=`.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType = 'application"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "folder-id"}] })),
            )
            .mount(&mock)
            .await;
        // The file-listing query falls through to this 503.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .list_files("dev-id", FileKind::Entries)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "503 on file listing must propagate as Network, got {err:?}"
        );
    }

    #[tokio::test]
    async fn list_files_returns_empty_on_200_with_no_files() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder queries have `mimeType = '...'`; file-listing has `mimeType !=`.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "mimeType = 'application"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "folder-id"}] })),
            )
            .mount(&mock)
            .await;
        // File listing (mimeType !=) returns 200 with empty files.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let files = provider
            .list_files("dev-id", FileKind::Entries)
            .await
            .unwrap();
        assert!(files.is_empty(), "genuine empty 200 must yield Ok(vec![])");
    }

    // ─── read_shared_file list-lookup fail-closed ─────────────────────────────

    #[tokio::test]
    async fn read_shared_file_returns_network_error_on_503_during_list_lookup() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder walk for `.meta` succeeds.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains(
                "q",
                "application/vnd.google-apps.folder",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-id"}] })),
            )
            .mount(&mock)
            .await;
        // File-by-name query (no mimeType filter) returns 503.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .read_shared_file(".meta/keyring.json")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "503 during list-lookup must propagate as Network (not NotFound), got {err:?}"
        );
    }

    #[tokio::test]
    async fn read_shared_file_returns_auth_error_on_401_during_list_lookup() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder walk for `.meta` succeeds.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains(
                "q",
                "application/vnd.google-apps.folder",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-id"}] })),
            )
            .mount(&mock)
            .await;
        // File-by-name query returns 401.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .read_shared_file(".meta/keyring.json")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "401 during list-lookup must propagate as Auth (not NotFound), got {err:?}"
        );
    }

    // ─── write_shared_file existence-check fail-closed ───────────────────────

    #[tokio::test]
    async fn write_shared_file_returns_error_and_does_not_create_on_503_existence_check() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder walk for `.meta` succeeds.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains(
                "q",
                "application/vnd.google-apps.folder",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-id"}] })),
            )
            .mount(&mock)
            .await;
        // Existence check (file-by-name, no mimeType filter) returns 503.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock)
            .await;
        // Prove no duplicate is created: expect(0) means wiremock panics on
        // mock-server drop if ANY POST fires against this endpoint.
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .write_shared_file(".meta/keyring.json", b"data")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "503 on existence check must fail closed (Network), not create a duplicate; got {err:?}"
        );
    }

    #[tokio::test]
    async fn write_shared_file_returns_auth_error_and_does_not_create_on_401_existence_check() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder walk for `.meta` succeeds.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains(
                "q",
                "application/vnd.google-apps.folder",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-id"}] })),
            )
            .mount(&mock)
            .await;
        // Existence check returns 401.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .write_shared_file(".meta/keyring.json", b"data")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Auth(_)),
            "401 on existence check must fail closed (Auth), not create a duplicate; got {err:?}"
        );
    }

    // ─── find_folder / resolve_file_id / resolve_shared_file_id: 403 ─────────

    #[tokio::test]
    async fn find_folder_treats_403_as_transient_network_error() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let token = provider.ensure_fresh_token().await.unwrap();
        let err = provider
            .find_folder("Memlore", "appDataFolder", &token)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "403 in find_folder must be Network (transient), got {err:?}"
        );
    }

    #[tokio::test]
    async fn resolve_file_id_treats_403_as_network_error() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .resolve_file_id("dev-uuid/entries/abc.bin")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "403 in resolve_file_id must be Network, got {err:?}"
        );
    }

    #[tokio::test]
    async fn resolve_shared_file_id_treats_403_as_network_error() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Folder walk for `.meta` succeeds.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains(
                "q",
                "application/vnd.google-apps.folder",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "meta-id"}] })),
            )
            .mount(&mock)
            .await;
        // File-by-name query returns 403.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        // resolve_shared_file_id is private; exercise it via KeyringV2Io::delete_file.
        let err = crate::sync::keyring_v2::KeyringV2Io::delete_file(&provider, SLOT_PATH)
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "403 in resolve_shared_file_id must be Network, got {err:?}"
        );
    }

    // ─── Retry tests ─────────────────────────────────────────────────────────

    /// A transient 503 followed by a 200 on a READ endpoint (list_devices)
    /// must succeed — the provider retries and returns the successful result.
    #[tokio::test]
    async fn read_retries_once_on_503_then_succeeds() {
        use wiremock::matchers::query_param_contains;
        let mock = MockServer::start().await;

        // Root folder discovery returns the Memlore root.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .and(query_param_contains("q", "name = 'Memlore'"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "files": [{"id": "root-id"}] })),
            )
            .up_to_n_times(1)
            .mount(&mock)
            .await;
        // First list_devices call → 503 (transient).
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&mock)
            .await;
        // Retry → 200 with one device folder.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "files": [{"id": "dev-folder", "name": "device-1"}] }),
            ))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        let devices = provider.list_devices().await.unwrap();
        assert_eq!(devices, vec!["device-1".to_string()]);
    }

    /// Persistent 503 on a READ endpoint exhausts all retries and returns a
    /// Network error. The mock uses `.expect(RETRY_MAX_ATTEMPTS)` to also
    /// assert the retry cap is honored.
    #[tokio::test]
    async fn read_exhausts_retries_and_returns_network_error() {
        let mock = MockServer::start().await;

        // Root folder already populated (skip discovery).
        // All GET calls → 503 forever; expect exactly RETRY_MAX_ATTEMPTS hits.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .expect(RETRY_MAX_ATTEMPTS as u64)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // Pre-populate root folder so the discover-root GET is skipped.
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider.list_devices().await.unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "exhausted retries must surface as Network, got {err:?}"
        );
        // wiremock panics on drop if .expect() is not met — assertion is implicit.
    }

    /// A POST (write) that returns 503 must NOT be retried — writes are
    /// single-shot to prevent duplicate-file creation. `.expect(1)` on the POST
    /// mock pins this: if the provider retried, wiremock would panic on drop.
    #[tokio::test]
    async fn write_is_not_retried_on_503() {
        let mock = MockServer::start().await;

        // Folder-walk GETs succeed (find_folder / find_canonical_root_folder).
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": [] })),
            )
            .mount(&mock)
            .await;
        // The folder-create POST returns 503 — must fire exactly once (no retry).
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri()).unwrap();
        // Trigger find_or_create_folder → folder missing → POST to create.
        let err = provider
            .find_or_create_folder("Memlore", "appDataFolder")
            .await
            .unwrap_err();
        assert!(
            matches!(err, SyncError::Network(_)),
            "503 on POST must surface as Network, got {err:?}"
        );
        // wiremock panic on drop guards that exactly 1 POST fired.
    }

    // ─── folder-ID cache regression coverage ─────────────────────────────

    /// **Critical regression**: `generation_root_for_read_cache` must never
    /// cache the miss (`None`). This instance's own write path
    /// (`ensure_generation_root`, invoked from `write_file`) can CREATE
    /// `generations/g-N` mid-cycle — e.g. right after a fresh recovery
    /// generation bump, before the namespace exists yet. If the earlier miss
    /// had been cached, a later same-cycle resolution for a different path
    /// would keep believing no generation namespace exists: the pull side
    /// would search the flat layout only (spurious `NotFound` for content
    /// that now lives under `g-N`), and a same-cycle re-write's existence
    /// check would also miss and take the create branch again
    /// (`find_or_create_folder` dedupes folders, not files → a duplicate
    /// same-name ciphertext blob).
    #[tokio::test]
    async fn generation_root_created_mid_cycle_by_own_write_is_visible_to_later_reads() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let generations_created = Arc::new(AtomicBool::new(false));
        let g1_created = Arc::new(AtomicBool::new(false));

        struct StatefulFolderLookupResponder {
            generations_created: Arc<AtomicBool>,
            g1_created: Arc<AtomicBool>,
        }
        impl wiremock::Respond for StatefulFolderLookupResponder {
            fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
                let req_path = request.url.path();
                if req_path == "/drive/v3/files/control-id" {
                    // `revalidate_recovery_fence_before_mutation` reads
                    // control.json before every folder-create POST.
                    return ResponseTemplate::new(200).set_body_json(serde_json::json!({
                        "version": 1,
                        "recovery_generation": 1,
                        "recovery_lease": null,
                        "updated_at": 1,
                    }));
                }
                if req_path != "/drive/v3/files" {
                    return ResponseTemplate::new(404);
                }
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                let files = if q.contains("name = '.meta'") {
                    serde_json::json!([{"id": "meta-id"}])
                } else if q.contains("name = 'control.json'") {
                    serde_json::json!([{"id": "control-id"}])
                } else if q.contains("name = 'generations'") {
                    if self.generations_created.load(Ordering::SeqCst) {
                        serde_json::json!([{"id": "gens-id"}])
                    } else {
                        serde_json::json!([])
                    }
                } else if q.contains("name = 'g-1'") {
                    if self.g1_created.load(Ordering::SeqCst) {
                        serde_json::json!([{"id": "gen-root"}])
                    } else {
                        serde_json::json!([])
                    }
                } else {
                    serde_json::json!([])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": files }))
            }
        }

        struct CreateFolderResponder {
            generations_created: Arc<AtomicBool>,
            g1_created: Arc<AtomicBool>,
        }
        impl wiremock::Respond for CreateFolderResponder {
            fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
                let body: serde_json::Value =
                    serde_json::from_slice(&request.body).expect("valid JSON create body");
                let id = match body["name"].as_str().unwrap_or_default() {
                    "generations" => {
                        self.generations_created.store(true, Ordering::SeqCst);
                        "gens-id"
                    }
                    "g-1" => {
                        self.g1_created.store(true, Ordering::SeqCst);
                        "gen-root"
                    }
                    other => panic!("unexpected folder create: {other}"),
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "id": id }))
            }
        }

        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(StatefulFolderLookupResponder {
                generations_created: generations_created.clone(),
                g1_created: g1_created.clone(),
            })
            .mount(&mock)
            .await;
        Mock::given(method("POST"))
            .and(path("/drive/v3/files"))
            .respond_with(CreateFolderResponder {
                generations_created: generations_created.clone(),
                g1_created: g1_created.clone(),
            })
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());
        let token = provider.ensure_fresh_token().await.unwrap();

        // Before any write: the generation namespace does not exist yet.
        let before = provider
            .generation_root_for_read("root-id", &token)
            .await
            .unwrap();
        assert_eq!(before, None, "generations/g-1 must not exist yet");

        // A write on this same instance creates the namespace mid-cycle
        // (mirrors what `write_file` does via `ensure_generation_root`).
        provider.ensure_generation_root("root-id").await.unwrap();

        // A later same-cycle resolution for a different path must observe
        // the freshly created generation root, not a stale cached miss.
        let after = provider
            .generation_root_for_read("root-id", &token)
            .await
            .unwrap();
        assert_eq!(
            after,
            Some("gen-root".to_string()),
            "must re-resolve and find the newly created generation root, not reuse a cached miss"
        );
    }

    /// **Important fix #1 regression**: `configure_recovery_fence_authority`
    /// re-stamps the expected generation on a LIVE instance (e.g. connect /
    /// wipe flows). Any folder-ID cache populated under the old generation
    /// must be cleared so a stale id from before the bump cannot leak into
    /// reads served after it.
    #[tokio::test]
    async fn configure_recovery_fence_authority_clears_folder_id_caches() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(SimulatedVaultResponder)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        // Warm all three caches.
        provider.read_file("peer-a/entries/e0.bin").await.unwrap();
        assert!(
            provider
                .generation_root_for_read_cache
                .read()
                .unwrap()
                .is_some(),
            "gen-root cache should be warm before reconfiguration"
        );
        assert!(
            !provider
                .device_folders_for_read_cache
                .read()
                .unwrap()
                .is_empty(),
            "device-folder cache should be warm before reconfiguration"
        );
        assert!(
            !provider.subfolder_cache.read().unwrap().is_empty(),
            "subfolder cache should be warm before reconfiguration"
        );

        // Simulate a live generation bump (as `gdrive_complete_connect` /
        // `gdrive_wipe_cloud` do on an already-constructed provider).
        provider.configure_recovery_fence_authority(2, None);

        assert!(
            provider
                .generation_root_for_read_cache
                .read()
                .unwrap()
                .is_none(),
            "gen-root cache must be cleared on reconfiguration"
        );
        assert!(
            provider
                .device_folders_for_read_cache
                .read()
                .unwrap()
                .is_empty(),
            "device-folder cache must be cleared on reconfiguration"
        );
        assert!(
            provider.subfolder_cache.read().unwrap().is_empty(),
            "subfolder cache must be cleared on reconfiguration"
        );
    }

    // ─── pull hot-path request-count benchmark ───────────────────────────

    /// Simulates a fenced vault (`generations/g-1` active) with one peer
    /// (`peer-a`) whose `entries/` folder serves every `e{i}.bin` lookup.
    /// Dispatches on the decoded `q=` parameter the way Drive would.
    struct SimulatedVaultResponder;
    impl wiremock::Respond for SimulatedVaultResponder {
        fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
            let q = request
                .url
                .query_pairs()
                .find(|(k, _)| k == "q")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let files = if q.contains("name = 'generations'") {
                serde_json::json!([{"id": "gens-id"}])
            } else if q.contains("name = 'g-1'") {
                serde_json::json!([{"id": "gen-root"}])
            } else if q.contains("name = 'peer-a'") && q.contains("'gen-root' in parents") {
                serde_json::json!([{"id": "peer-gen"}])
            } else if q.contains("name = 'peer-a'") {
                // Flat-layout dual-read miss: no legacy folder.
                serde_json::json!([])
            } else if q.contains("name = 'entries'") {
                serde_json::json!([{"id": "entries-id"}])
            } else if q.contains(".bin'") {
                serde_json::json!([{"id": "blob-1", "name": "e.bin"}])
            } else {
                serde_json::json!([])
            };
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": files }))
        }
    }

    /// Measures how many HTTP round trips N sequential `read_file` calls on
    /// the pull hot path cost, and pins the window to the per-instance
    /// folder-ID caching added for this path: the first file pays the full
    /// folder walk (generation root + device folders + subfolder — up to 7
    /// requests), every subsequent file only re-does the per-file name
    /// lookup + `alt=media` download (exactly 2 requests). Prints the counts
    /// so a benchmark run (`cargo test pull_hot_path -- --nocapture`) shows
    /// requests/file; the assertion below guards against a future caching
    /// regression silently reintroducing the re-resolve-per-file cost.
    #[tokio::test]
    async fn pull_hot_path_request_count() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(SimulatedVaultResponder)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        const N: usize = 20;
        for i in 0..N {
            let bytes = provider
                .read_file(&format!("peer-a/entries/e{i}.bin"))
                .await
                .unwrap();
            assert_eq!(bytes, b"payload");
        }

        let total = mock.received_requests().await.unwrap().len();
        eprintln!(
            "pull hot path: {total} HTTP requests for {N} read_file calls ({:.1} requests/file)",
            total as f64 / N as f64
        );
        // Floor: at least a per-file name lookup + download must remain.
        assert!(total >= N * 2, "expected at least 2 requests per file");
        // Ceiling: first file pays the folder walk once (<=7 requests), every
        // subsequent file costs exactly 2 (name lookup + download). Without
        // the per-instance caches this file re-resolves the whole chain
        // (7/file) and would blow past this window.
        assert!(
            total <= 7 + (N - 1) * 2 + 1,
            "expected the folder-ID cache to bound cost to ~1 walk + 2/file, got {total}"
        );
    }

    /// A second `read_file` for the same peer + subfolder must reuse the
    /// cached generation-root, device-folder, and subfolder resolutions —
    /// only the per-file name lookup + download should re-hit the network.
    #[tokio::test]
    async fn second_read_file_same_peer_and_subfolder_costs_two_requests() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(SimulatedVaultResponder)
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        provider.read_file("peer-a/entries/e0.bin").await.unwrap();
        let before = mock.received_requests().await.unwrap().len();

        let bytes = provider.read_file("peer-a/entries/e1.bin").await.unwrap();
        assert_eq!(bytes, b"payload");

        let after = mock.received_requests().await.unwrap().len();
        assert_eq!(
            after - before,
            2,
            "second read_file should only pay for the name lookup + download"
        );
    }

    /// A flat-only vault (no `generations/` folder on Drive ever) must NOT
    /// cache the `None` generation-root miss (see the critical fix above):
    /// each *distinct* device_id's first read still re-queries
    /// `find_folder("generations", …)`, because `device_folders_for_read_cache`
    /// only short-circuits repeat reads of the SAME device, not the first
    /// read of a new one. So for N distinct devices (one read each) the
    /// `generations` query must fire exactly N times, not once.
    #[tokio::test]
    async fn flat_only_vault_generation_root_miss_is_not_cached_across_devices() {
        let mock = MockServer::start().await;
        // No "generations" folder exists — every lookup for it returns empty.
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(move |request: &wiremock::Request| {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                let files = if q.contains("name = 'generations'") {
                    serde_json::json!([])
                } else if q.contains("name = 'peer-x'") {
                    serde_json::json!([{"id": "peer-x-flat"}])
                } else if q.contains("name = 'peer-y'") {
                    serde_json::json!([{"id": "peer-y-flat"}])
                } else if q.contains("name = 'peer-z'") {
                    serde_json::json!([{"id": "peer-z-flat"}])
                } else if q.contains("name = 'entries'") && q.contains("'peer-x-flat' in parents") {
                    serde_json::json!([{"id": "peer-x-entries"}])
                } else if q.contains("name = 'entries'") && q.contains("'peer-y-flat' in parents") {
                    serde_json::json!([{"id": "peer-y-entries"}])
                } else if q.contains("name = 'entries'") && q.contains("'peer-z-flat' in parents") {
                    serde_json::json!([{"id": "peer-z-entries"}])
                } else if q.contains("'peer-x-entries' in parents") {
                    serde_json::json!([{"id": "peer-x-blob", "name": "e0.bin"}])
                } else if q.contains("'peer-y-entries' in parents") {
                    serde_json::json!([{"id": "peer-y-blob", "name": "e0.bin"}])
                } else if q.contains("'peer-z-entries' in parents") {
                    serde_json::json!([{"id": "peer-z-blob", "name": "e0.bin"}])
                } else {
                    serde_json::json!([])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": files }))
            })
            .mount(&mock)
            .await;
        for blob in ["peer-x-blob", "peer-y-blob", "peer-z-blob"] {
            Mock::given(method("GET"))
                .and(path(format!("/drive/v3/files/{blob}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
                .mount(&mock)
                .await;
        }

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        const DEVICES: [&str; 3] = ["peer-x", "peer-y", "peer-z"];
        for device in DEVICES {
            let bytes = provider
                .read_file(&format!("{device}/entries/e0.bin"))
                .await
                .unwrap();
            assert_eq!(bytes, b"payload");
        }

        let generations_queries = mock
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|req| {
                req.url
                    .query_pairs()
                    .any(|(k, v)| k == "q" && v.contains("name = 'generations'"))
            })
            .count();
        assert_eq!(
            generations_queries,
            DEVICES.len(),
            "the None generation-root result must never be cached — each distinct \
             device's first read re-queries it"
        );
    }

    /// Mirror image of the miss case above: in a genuinely FENCED vault
    /// (`generations/g-1` exists), the `Some` generation-root result IS
    /// cached and shared across distinct device_ids — unlike
    /// `device_folders_for_read_cache` (per-device), this cache has no key,
    /// so the combined `generations` + `g-1` query count across TWO devices
    /// must be 2 (fired once, on the first device's resolution), not 4.
    #[tokio::test]
    async fn fenced_vault_generation_root_cache_is_shared_across_devices() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(move |request: &wiremock::Request| {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                let files = if q.contains("name = 'generations'") {
                    serde_json::json!([{"id": "gens-id"}])
                } else if q.contains("name = 'g-1'") {
                    serde_json::json!([{"id": "gen-root"}])
                } else if q.contains("name = 'peer-a'") && q.contains("'gen-root' in parents") {
                    serde_json::json!([{"id": "peer-a-gen"}])
                } else if q.contains("name = 'peer-a'") {
                    serde_json::json!([])
                } else if q.contains("name = 'peer-d'") && q.contains("'gen-root' in parents") {
                    serde_json::json!([{"id": "peer-d-gen"}])
                } else if q.contains("name = 'peer-d'") {
                    serde_json::json!([])
                } else if q.contains("name = 'entries'") && q.contains("'peer-a-gen' in parents") {
                    serde_json::json!([{"id": "entries-a"}])
                } else if q.contains("name = 'entries'") && q.contains("'peer-d-gen' in parents") {
                    serde_json::json!([{"id": "entries-d"}])
                } else if q.contains("'entries-a' in parents") {
                    serde_json::json!([{"id": "blob-a", "name": "e0.bin"}])
                } else if q.contains("'entries-d' in parents") {
                    serde_json::json!([{"id": "blob-d", "name": "e0.bin"}])
                } else {
                    serde_json::json!([])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": files }))
            })
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-a"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload-a".to_vec()))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-d"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload-d".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let a = provider.read_file("peer-a/entries/e0.bin").await.unwrap();
        assert_eq!(a, b"payload-a");
        let d = provider.read_file("peer-d/entries/e0.bin").await.unwrap();
        assert_eq!(d, b"payload-d");

        let gen_queries = mock
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|req| {
                req.url.query_pairs().any(|(k, v)| {
                    k == "q" && (v.contains("name = 'generations'") || v.contains("name = 'g-1'"))
                })
            })
            .count();
        assert_eq!(
            gen_queries, 2,
            "the Some generation-root result must be cached and shared across devices \
             (1 generations + 1 g-1 query total, not repeated per device)"
        );
    }

    /// An empty device-folder resolution must NOT be cached: the first read
    /// of a not-yet-existing peer returns `NotFound`, and once the peer
    /// folder appears on Drive the very next read must succeed (no stale
    /// empty-miss cached from the first attempt).
    #[tokio::test]
    async fn empty_device_folder_resolution_is_not_cached() {
        let mock = MockServer::start().await;
        let peer_exists = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let peer_exists_responder = peer_exists.clone();
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(move |request: &wiremock::Request| {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                let files = if q.contains("name = 'generations'") {
                    serde_json::json!([])
                } else if q.contains("name = 'peer-b'") {
                    if peer_exists_responder.load(std::sync::atomic::Ordering::SeqCst) {
                        serde_json::json!([{"id": "peer-flat"}])
                    } else {
                        serde_json::json!([])
                    }
                } else if q.contains("name = 'entries'") {
                    serde_json::json!([{"id": "entries-id"}])
                } else if q.contains(".bin'") {
                    serde_json::json!([{"id": "blob-1", "name": "e.bin"}])
                } else {
                    serde_json::json!([])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": files }))
            })
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let err = provider
            .read_file("peer-b/entries/e0.bin")
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::NotFound(_)));

        // Peer folder appears on Drive mid-cycle.
        peer_exists.store(true, std::sync::atomic::Ordering::SeqCst);

        let bytes = provider.read_file("peer-b/entries/e0.bin").await.unwrap();
        assert_eq!(bytes, b"payload");
    }

    /// Different `device_id`s must resolve independently — no cross-device
    /// contamination in the device-folder or subfolder caches.
    #[tokio::test]
    async fn different_device_ids_resolve_independently() {
        let mock = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files"))
            .respond_with(move |request: &wiremock::Request| {
                let q = request
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                let files = if q.contains("name = 'generations'") {
                    serde_json::json!([])
                } else if q.contains("name = 'peer-a'") {
                    serde_json::json!([{"id": "peer-a-flat"}])
                } else if q.contains("name = 'peer-c'") {
                    serde_json::json!([{"id": "peer-c-flat"}])
                } else if q.contains("name = 'entries'") && q.contains("'peer-a-flat' in parents") {
                    serde_json::json!([{"id": "entries-a"}])
                } else if q.contains("name = 'entries'") && q.contains("'peer-c-flat' in parents") {
                    serde_json::json!([{"id": "entries-c"}])
                } else if q.contains("'entries-a' in parents") {
                    serde_json::json!([{"id": "blob-a", "name": "e.bin"}])
                } else if q.contains("'entries-c' in parents") {
                    serde_json::json!([{"id": "blob-c", "name": "e.bin"}])
                } else {
                    serde_json::json!([])
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "files": files }))
            })
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-a"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload-a".to_vec()))
            .mount(&mock)
            .await;
        Mock::given(method("GET"))
            .and(path("/drive/v3/files/blob-c"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"payload-c".to_vec()))
            .mount(&mock)
            .await;

        let provider = GDriveProvider::new(make_session("tok"), &mock.uri(), &mock.uri())
            .unwrap()
            .with_recovery_fence(1, None);
        *provider.root_folder_id.write().await = Some("root-id".to_string());

        let a = provider.read_file("peer-a/entries/e0.bin").await.unwrap();
        assert_eq!(a, b"payload-a");
        let c = provider.read_file("peer-c/entries/e0.bin").await.unwrap();
        assert_eq!(c, b"payload-c");

        // Both devices independently reach their own file — no cache
        // cross-contamination swapped one peer's folder for the other's.
        let a_again = provider.read_file("peer-a/entries/e1.bin").await.unwrap();
        assert_eq!(a_again, b"payload-a");
        let c_again = provider.read_file("peer-c/entries/e1.bin").await.unwrap();
        assert_eq!(c_again, b"payload-c");

        // Pin the total so this test actually fails if the caches were
        // removed entirely (device-folder + subfolder caches would then
        // re-resolve on every one of the 4 reads instead of only the first
        // read of each distinct device).
        let total = mock.received_requests().await.unwrap().len();
        assert_eq!(
            total, 14,
            "expected 5 requests for each device's first read (generations miss + \
             device folder + subfolder + name lookup + download) and 2 requests \
             for each device's second read (name lookup + download); got {total}"
        );
    }
}
