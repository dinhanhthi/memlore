//! Custom Google Font commands.
//!
//! Lets the UI pick a Google Font via the catalog search and cache the font file
//! under `<app_data>/fonts/<slug>/<weight>.<ext>`. The Tauri frontend then
//! injects an `@font-face` rule pointing at the cached file via the asset
//! protocol (`asset://`), so subsequent app launches work fully offline.

use crate::db::google_fonts_catalog::{self, CatalogEntry, CatalogMeta};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;
use tauri::{AppHandle, Manager};

/// Cache size snapshot returned by `get_font_cache_stats` and
/// `clear_font_cache`. Mirrors the `MediaCacheStats` pattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCacheStats {
    pub used_bytes: u64,
    pub font_count: u32,
}

/// Result of `download_google_font` — used by the frontend to build the
/// runtime `@font-face` rule.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedFont {
    pub family: String,
    pub weight: u32,
    /// Absolute on-disk path; the frontend passes it through `convertFileSrc`.
    pub local_path: String,
}

/// User-Agent that forces Google Fonts CSS API to return woff2 URLs (older
/// UAs get ttf, which we don't want — bigger and slower to decode).
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                         AppleWebKit/537.36 (KHTML, like Gecko) \
                         Chrome/120.0.0.0 Safari/537.36";

/// woff2 magic bytes — the first 4 bytes of a valid woff2 file spell `wOF2`.
const WOFF2_MAGIC: [u8; 4] = [0x77, 0x4f, 0x46, 0x32];

/// TrueType font magic bytes (standard TTF).
const TTF_MAGIC: [u8; 4] = [0x00, 0x01, 0x00, 0x00];

/// OpenType CFF magic bytes ("OTTO").
const OTTO_MAGIC: [u8; 4] = [0x4f, 0x54, 0x54, 0x4f];

/// TrueType/OpenType TTC collection magic bytes ("ttcf").
const TTCF_MAGIC: [u8; 4] = [0x74, 0x74, 0x63, 0x66];

/// Sentinel returned to the frontend when GOOGLE_FONTS_API_KEY is not set.
const API_KEY_MISSING_SENTINEL: &str = "GOOGLE_FONTS_API_KEY_MISSING";

/// Google Fonts Developer API endpoint.
const GOOGLE_FONTS_API_BASE: &str = "https://www.googleapis.com/webfonts/v1/webfonts";

/// Detect the font format from magic bytes and return the appropriate
/// file extension.  Returns `None` for unknown / corrupt data.
fn detect_font_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }
    let magic = &bytes[0..4];
    if magic == WOFF2_MAGIC {
        Some("woff2")
    } else if magic == TTF_MAGIC || magic == OTTO_MAGIC || magic == TTCF_MAGIC {
        Some("ttf")
    } else {
        None
    }
}

/// Allowed weights — the standard CSS font-weight scale. Anything else is
/// rejected at the command boundary so we never construct URLs with junk.
const ALLOWED_WEIGHTS: [u32; 9] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/// Turn a Google Fonts family name into a filesystem-safe slug.
///
/// Lowercase, alphanumerics kept as-is, every other char becomes `-`,
/// repeated dashes collapsed, leading/trailing dashes trimmed. Defends
/// against path traversal (e.g. `"a/b\\c"` → `"a-b-c"` rather than nested
/// directories) — the slugified family name is used as a directory name.
fn slugify_family(family: &str) -> String {
    let mut out = String::with_capacity(family.len());
    let mut prev_dash = false;
    for ch in family.chars() {
        if ch.is_ascii_alphanumeric() {
            for c in ch.to_lowercase() {
                out.push(c);
            }
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    // Strip the trailing dash we might have just appended.
    if out.ends_with('-') {
        out.pop();
    }
    out
}

/// Resolve (and create if needed) the cache directory `<app_data>/fonts/`.
fn fonts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Validate the input family string. Whitelist-only so untrusted input
/// cannot poison the Google Fonts URL or escape the cache directory.
fn validate_family(family: &str) -> Result<(), String> {
    if family.is_empty() || family.len() > 64 {
        return Err("invalid family length".into());
    }
    let ok = family
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '+'));
    if !ok {
        return Err("invalid characters in family name".into());
    }
    // Reject punctuation-only names ("+++", "---", "   ") because
    // `slugify_family` would return "" for them, which would cause the
    // download to land directly under the fonts cache root instead of a
    // family directory. See `slugify_family_punctuation_only_is_empty`.
    if !family.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("family name must contain at least one alphanumeric".into());
    }
    Ok(())
}

/// Validate the weight against the standard CSS scale.
fn validate_weight(weight: u32) -> Result<(), String> {
    if ALLOWED_WEIGHTS.contains(&weight) {
        Ok(())
    } else {
        Err(format!("weight {weight} not in 100..=900 step 100"))
    }
}

/// Find the first `url(https://fonts.gstatic.com/….woff2)` in a CSS block.
/// The URL may or may not be wrapped in quotes — accept both. Plain `str`
/// scanning; replaces a former `regex` dependency
/// (`url\(["']?(https://fonts\.gstatic\.com/[^)"']+?\.woff2)["']?\)`).
fn find_gstatic_woff2_url(block: &str) -> Option<&str> {
    for (idx, _) in block.match_indices("url(") {
        let rest = &block[idx + 4..];
        let rest = rest.strip_prefix(['"', '\'']).unwrap_or(rest);
        // The URL body runs to the first `)`, `"`, or `'`.
        let Some(end) = rest.find([')', '"', '\'']) else {
            continue;
        };
        let url = &rest[..end];
        // After the URL: an optional closing quote, then `)`.
        let tail = &rest[end..];
        let tail = tail.strip_prefix(['"', '\'']).unwrap_or(tail);
        if tail.starts_with(')')
            && url.starts_with("https://fonts.gstatic.com/")
            && url.ends_with(".woff2")
        {
            return Some(url);
        }
    }
    None
}

/// Pick the woff2 URL belonging to the **latin** subset of a Google Fonts
/// CSS response. The response typically contains several `@font-face`
/// blocks (one per unicode subset: cyrillic, greek, vietnamese, latin-ext,
/// latin); we pick the latin block because Memlore's UI/text is
/// predominantly Latin-script. If no latin block is found, fall back to the
/// last `@font-face` block (Google orders them with latin last for
/// historical-cache reasons).
fn pick_latin_woff2_url(css: &str) -> Option<String> {
    // Naive split: `@font-face {` does not appear inside its own body so
    // splitting on it is safe.
    let blocks: Vec<&str> = css.split("@font-face").skip(1).collect();
    if blocks.is_empty() {
        return None;
    }

    let mut latin_url: Option<String> = None;
    let mut last_url: Option<String> = None;

    for block in &blocks {
        if let Some(url) = find_gstatic_woff2_url(block) {
            let url = url.to_string();
            last_url = Some(url.clone());
            // The latin subset's unicode-range always contains U+0000-00FF.
            // Some single-subset fonts (display/handwriting) have no
            // unicode-range at all — for those, the first block is the
            // latin one by default.
            if block.contains("U+0000-00FF") || !block.contains("unicode-range:") {
                latin_url = Some(url);
                // Don't break — if both conditions match later we want the
                // explicit latin one. But the unicode-range==U+0000-00FF
                // check is reliable enough; keep scanning to prefer it.
                if block.contains("U+0000-00FF") {
                    break;
                }
            }
        }
    }

    latin_url.or(last_url)
}

/// Download a Google Font file into the cache. Idempotent: if the target file
/// already exists and has a valid magic header, returns immediately.
///
/// When `url` is provided (from the catalog's `files` map), the bytes are
/// fetched directly from that URL and the extension is chosen from the
/// detected format.  When `url` is omitted, the old CSS-API path is used
/// (always fetches woff2).
#[tauri::command]
pub async fn download_google_font(
    app: AppHandle,
    family: String,
    weight: u32,
    url: Option<String>,
) -> Result<DownloadedFont, String> {
    validate_family(&family)?;
    validate_weight(weight)?;

    let base = fonts_dir(&app)?;
    let family_dir = base.join(slugify_family(&family));

    // --- Cache hit probe: check both .woff2 and .ttf for this weight --------
    for ext in ["woff2", "ttf"] {
        let candidate = family_dir.join(format!("{weight}.{ext}"));
        if let Ok(meta) = tokio::fs::metadata(&candidate).await {
            if meta.is_file() && meta.len() >= 4 {
                let mut head = [0u8; 4];
                if let Ok(mut f) = tokio::fs::File::open(&candidate).await {
                    use tokio::io::AsyncReadExt;
                    if f.read_exact(&mut head).await.is_ok()
                        && detect_font_extension(&head).is_some()
                    {
                        return Ok(DownloadedFont {
                            family,
                            weight,
                            local_path: candidate.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
        }
    }

    let client = reqwest::Client::new();
    let (bytes, file_ext) = if let Some(direct_url) = url {
        // Direct URL path (from catalog): validate origin before fetching.
        if !direct_url.starts_with("https://fonts.gstatic.com/") {
            return Err(format!(
                "font URL must start with https://fonts.gstatic.com/, got: {direct_url}"
            ));
        }
        let bytes = client
            .get(&direct_url)
            .header("User-Agent", CHROME_UA)
            .send()
            .await
            .map_err(|e| format!("font fetch failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("font fetch returned non-2xx: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("read font body failed: {e}"))?;

        let ext = detect_font_extension(&bytes).ok_or_else(|| {
            "downloaded file has unknown magic bytes — not a recognized font format".to_string()
        })?;
        (bytes, ext)
    } else {
        // Legacy CSS-API path: fetch woff2.
        let css_url = format!(
            "https://fonts.googleapis.com/css2?family={}:wght@{}&display=swap",
            family.replace(' ', "+"),
            weight
        );
        let css_resp = client
            .get(&css_url)
            .header("User-Agent", CHROME_UA)
            .send()
            .await
            .map_err(|e| format!("Google Fonts CSS fetch failed: {e}"))?;
        let status = css_resp.status();
        if !status.is_success() {
            return Err(format!("Google Fonts returned HTTP {status}"));
        }
        let css = css_resp
            .text()
            .await
            .map_err(|e| format!("read CSS body failed: {e}"))?;

        let woff2_url =
            pick_latin_woff2_url(&css).ok_or_else(|| "no woff2 URL in CSS response".to_string())?;

        let bytes = client
            .get(&woff2_url)
            .header("User-Agent", CHROME_UA)
            .send()
            .await
            .map_err(|e| format!("woff2 fetch failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("woff2 fetch returned non-2xx: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("read woff2 body failed: {e}"))?;

        if bytes.len() < 4 || bytes[0..4] != WOFF2_MAGIC {
            return Err("downloaded file failed woff2 magic-byte check".into());
        }
        (bytes, "woff2")
    };

    // Atomic write: temp file → rename.
    tokio::fs::create_dir_all(&family_dir)
        .await
        .map_err(|e| format!("create family dir failed: {e}"))?;
    let final_path = family_dir.join(format!("{weight}.{file_ext}"));
    let tmp_path = family_dir.join(format!(".{weight}.{file_ext}.tmp"));
    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| format!("write tmp file failed: {e}"))?;
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| format!("rename to final path failed: {e}"))?;

    Ok(DownloadedFont {
        family,
        weight,
        local_path: final_path.to_string_lossy().into_owned(),
    })
}

// ─── Google Fonts Catalog commands ───────────────────────────────────────────

/// Serde shape for the Google Fonts Developer API response.
#[derive(Debug, Deserialize)]
struct GFApiResponse {
    items: Vec<GFApiItem>,
}

#[derive(Debug, Deserialize)]
struct GFApiItem {
    family: String,
    category: String,
    variants: Vec<String>,
    files: std::collections::HashMap<String, String>,
}

/// Strip the API key (and the surrounding `?key=…` / `&key=…` query param)
/// from any string that may leak via a `reqwest::Error` Display impl.
///
/// `reqwest::Error::Display` includes the full request URL, which embeds the
/// API key as a query string. Without this redaction, every network error
/// returned to the frontend would expose the key. Also strips the bare key
/// in case it appears outside a URL (defensive — should not happen).
fn redact_api_key(s: &str, api_key: &str) -> String {
    if api_key.is_empty() {
        return s.to_string();
    }
    // Match the key when it is the value of a `key=` query param so we drop
    // the surrounding delimiters cleanly. Falls back to a bare replace for
    // any other appearance.
    let with_amp = format!("&key={api_key}");
    let with_q = format!("?key={api_key}");
    s.replace(&with_amp, "")
        .replace(&with_q, "?")
        .replace(api_key, "[REDACTED]")
}

/// Filter an upstream catalog entry: drop rows whose family name fails
/// validation or whose `files` map contains URLs outside the trusted
/// `fonts.gstatic.com` origin. This is defense-in-depth at the trust
/// boundary — the consumer (`download_google_font`) also validates, but
/// keeping bad rows out of the cache avoids showing them in the search UI.
fn sanitize_catalog_entry(item: GFApiItem) -> Option<CatalogEntry> {
    if validate_family(&item.family).is_err() {
        return None;
    }
    // Keep only file URLs from the trusted CDN.
    let files: std::collections::HashMap<String, String> = item
        .files
        .into_iter()
        .filter(|(_, url): &(String, String)| url.starts_with("https://fonts.gstatic.com/"))
        .collect();
    if files.is_empty() {
        return None;
    }
    Some(CatalogEntry {
        family: item.family,
        category: item.category,
        variants: item.variants,
        files,
    })
}

/// Compile-time API key, surfaced by `build.rs` from the project `.env`.
///
/// `option_env!` reads the env var **at compile time** — Tauri's dev runner
/// does not feed `.env` into the cargo process, so a pure runtime lookup
/// (`std::env::var`) would always miss in `pnpm tauri dev`. `build.rs`
/// re-runs whenever `.env` changes and forwards the value via
/// `cargo:rustc-env=...`, matching the GDRIVE OAuth key pattern in
/// `sync/gdrive_oauth.rs`.
fn google_fonts_api_key() -> Option<&'static str> {
    option_env!("GOOGLE_FONTS_API_KEY")
        .map(str::trim)
        .filter(|k| !k.is_empty())
}

/// Fetch the Google Fonts catalog from the API and store it in the SQLite cache.
///
/// Returns the sentinel string `GOOGLE_FONTS_API_KEY_MISSING` as the error
/// payload when the `GOOGLE_FONTS_API_KEY` env var is unset, so the frontend
/// can render a specific message. All other error messages are scrubbed of
/// the API key before being returned.
#[tauri::command]
pub async fn refresh_google_fonts_catalog(app: AppHandle) -> Result<CatalogMeta, String> {
    log::info!("refresh_google_fonts_catalog: invoked");
    let api_key = match google_fonts_api_key() {
        Some(k) => {
            log::info!(
                "refresh_google_fonts_catalog: api key present (len {})",
                k.len()
            );
            k.to_string()
        }
        None => {
            log::warn!(
                "refresh_google_fonts_catalog: GOOGLE_FONTS_API_KEY missing at compile time"
            );
            return Err(API_KEY_MISSING_SENTINEL.to_string());
        }
    };

    // Network fetch — error messages run through `redact_api_key` so the key
    // never reaches the frontend even if reqwest includes the URL. A finite
    // timeout (15s) prevents a stuck DNS/TLS handshake from leaving the
    // loading-catalog modal in an indefinite spinner state.
    let url = format!("{GOOGLE_FONTS_API_BASE}?key={api_key}&sort=alpha");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("User-Agent", CHROME_UA)
        .send()
        .await
        .map_err(|e| redact_api_key(&format!("Google Fonts API request failed: {e}"), &api_key))?
        .error_for_status()
        .map_err(|e| {
            redact_api_key(&format!("Google Fonts API returned non-2xx: {e}"), &api_key)
        })?;

    let api_resp: GFApiResponse = resp.json().await.map_err(|e| {
        redact_api_key(
            &format!("failed to parse Google Fonts API response: {e}"),
            &api_key,
        )
    })?;

    // Sanitize at the trust boundary: drop families that fail validation
    // (path-traversal defense) and drop file URLs that don't point at the
    // trusted CDN.
    let entries: Vec<CatalogEntry> = api_resp
        .items
        .into_iter()
        .filter_map(sanitize_catalog_entry)
        .collect();

    // Wrap the synchronous DB transaction in `spawn_blocking` so the
    // ~1800-row DELETE + bulk INSERT doesn't pin the tokio runtime thread
    // for hundreds of ms. The AppState mutex is still serialised, but at
    // least the runtime can drive other futures during the wait.
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let mut conn = state.lock()?;
        google_fonts_catalog::upsert_catalog(&mut conn, &entries).map_err(|e| e.to_string())?;
        google_fonts_catalog::get_meta(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("catalog write task failed: {e}"))?
}

/// Search the cached Google Fonts catalog by family name substring.
///
/// An empty query returns an empty list (never dumps the full ~1800-row
/// table). Results are ordered alphabetically, capped at `limit` (default 100).
#[tauri::command]
pub fn search_google_fonts_catalog(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<CatalogEntry>, String> {
    let conn = state.lock()?;
    google_fonts_catalog::search(&conn, &query, limit.unwrap_or(100)).map_err(|e| e.to_string())
}

/// Return the catalog metadata (last fetch timestamp and count).
#[tauri::command]
pub fn get_google_fonts_catalog_meta(state: State<'_, AppState>) -> Result<CatalogMeta, String> {
    log::info!("get_google_fonts_catalog_meta: invoked");
    let conn = state.lock()?;
    let meta = google_fonts_catalog::get_meta(&conn).map_err(|e| e.to_string())?;
    log::info!(
        "get_google_fonts_catalog_meta: fetched_at={:?} count={}",
        meta.fetched_at,
        meta.count
    );
    Ok(meta)
}

/// Compute cache stats for a given fonts directory. Pulled out of the
/// command so tests can pass a tempdir without an `AppHandle`.
///
/// A "font" is any direct child directory under `fonts_root`. We count even
/// empty family dirs as 1 font (partial-download cleanup may leave one
/// behind) so the count stays consistent with what the user sees on disk.
fn font_stats_in(fonts_root: &Path) -> std::io::Result<FontCacheStats> {
    if !fonts_root.exists() {
        return Ok(FontCacheStats {
            used_bytes: 0,
            font_count: 0,
        });
    }
    let mut used: u64 = 0;
    let mut count: u32 = 0;
    for entry in std::fs::read_dir(fonts_root)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if !ft.is_dir() {
            continue;
        }
        count += 1;
        for inner in std::fs::read_dir(entry.path())? {
            let inner = inner?;
            let path = inner.path();
            let ext = path.extension().and_then(|s| s.to_str());
            if matches!(ext, Some("woff2") | Some("ttf")) {
                if let Ok(meta) = std::fs::metadata(&path) {
                    used += meta.len();
                }
            }
        }
    }
    Ok(FontCacheStats {
        used_bytes: used,
        font_count: count,
    })
}

/// Report current font-cache usage. Returns zeros if the cache dir does not
/// exist yet.
#[tauri::command]
pub fn get_font_cache_stats(app: AppHandle) -> Result<FontCacheStats, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    font_stats_in(&dir).map_err(|e| e.to_string())
}

/// Delete every cached font file. The caller (frontend) is responsible for
/// resetting the active font selection if it pointed at a now-deleted file.
#[tauri::command]
pub fn clear_font_cache(app: AppHandle) -> Result<FontCacheStats, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    font_stats_in(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn slugify_family_basics() {
        assert_eq!(slugify_family("Noto Serif"), "noto-serif");
        assert_eq!(slugify_family("DM Sans"), "dm-sans");
        assert_eq!(slugify_family("Roboto"), "roboto");
        assert_eq!(slugify_family("IBM Plex Mono"), "ibm-plex-mono");
    }

    #[test]
    fn slugify_family_no_leading_trailing_dashes() {
        assert_eq!(slugify_family("  Open  Sans  "), "open-sans");
        assert_eq!(slugify_family("---X---"), "x");
    }

    #[test]
    fn slugify_family_strips_path_separators() {
        // Path-traversal defense: separators must never survive.
        assert_eq!(slugify_family("a/b\\c"), "a-b-c");
        assert_eq!(slugify_family("../etc/passwd"), "etc-passwd");
    }

    #[test]
    fn slugify_family_collapses_repeats() {
        assert_eq!(slugify_family("a   b"), "a-b");
        assert_eq!(slugify_family("a___b"), "a-b");
    }

    #[test]
    fn validate_family_accepts_common_names() {
        assert!(validate_family("Roboto").is_ok());
        assert!(validate_family("IBM Plex Sans").is_ok());
        assert!(validate_family("Source Sans 3").is_ok());
    }

    #[test]
    fn validate_family_rejects_bad_input() {
        assert!(validate_family("").is_err());
        assert!(validate_family("a".repeat(65).as_str()).is_err());
        assert!(validate_family("Roboto<script>").is_err());
        assert!(validate_family("Roboto/../etc").is_err());
        assert!(validate_family("Roboto;rm -rf").is_err());
    }

    #[test]
    fn validate_family_rejects_punctuation_only() {
        // These would slugify to "" and cause the woff2 to land outside its
        // family directory. The validator must catch them.
        assert!(validate_family("+++").is_err());
        assert!(validate_family("---").is_err());
        assert!(validate_family("   ").is_err());
        assert!(validate_family(" - + ").is_err());
    }

    #[test]
    fn slugify_family_punctuation_only_is_empty() {
        // Documents the slugifier's behavior. `validate_family` rejects
        // these strings before they ever reach `slugify_family` in
        // production — this test exists to lock in the contract.
        assert_eq!(slugify_family("+++"), "");
        assert_eq!(slugify_family("   "), "");
    }

    #[test]
    fn validate_weight_accepts_standard_scale() {
        for w in [100, 200, 300, 400, 500, 600, 700, 800, 900] {
            assert!(validate_weight(w).is_ok(), "weight {w} should be ok");
        }
    }

    #[test]
    fn validate_weight_rejects_offscale() {
        assert!(validate_weight(0).is_err());
        assert!(validate_weight(450).is_err());
        assert!(validate_weight(1000).is_err());
    }

    #[test]
    fn pick_latin_woff2_url_picks_latin_block() {
        let css = r#"
            /* cyrillic */
            @font-face {
              font-family: 'Roboto';
              src: url(https://fonts.gstatic.com/s/roboto/v51/cyrillic.woff2) format('woff2');
              unicode-range: U+0301, U+0400-045F;
            }
            /* latin */
            @font-face {
              font-family: 'Roboto';
              src: url(https://fonts.gstatic.com/s/roboto/v51/latin.woff2) format('woff2');
              unicode-range: U+0000-00FF, U+0131, U+0152-0153;
            }
        "#;
        let url = pick_latin_woff2_url(css).unwrap();
        assert!(url.ends_with("/latin.woff2"), "got {url}");
    }

    #[test]
    fn pick_latin_woff2_url_falls_back_to_last_block() {
        // Some display fonts have no unicode-range at all — pick the (only) block.
        let css = r#"
            @font-face {
              font-family: 'Lobster';
              src: url(https://fonts.gstatic.com/s/lobster/v30/x.woff2) format('woff2');
            }
        "#;
        let url = pick_latin_woff2_url(css).unwrap();
        assert!(url.ends_with("/x.woff2"));
    }

    #[test]
    fn pick_latin_woff2_url_returns_none_on_empty_css() {
        assert!(pick_latin_woff2_url("").is_none());
        assert!(pick_latin_woff2_url("body { color: red; }").is_none());
    }

    #[test]
    fn pick_latin_woff2_url_handles_quoted_url() {
        let css = r#"
            @font-face {
              src: url("https://fonts.gstatic.com/s/x/y.woff2") format('woff2');
              unicode-range: U+0000-00FF;
            }
        "#;
        let url = pick_latin_woff2_url(css).unwrap();
        assert_eq!(url, "https://fonts.gstatic.com/s/x/y.woff2");
    }

    #[test]
    fn pick_latin_woff2_url_handles_single_quoted_url() {
        let css = r#"
            @font-face {
              src: url('https://fonts.gstatic.com/s/x/y.woff2') format('woff2');
              unicode-range: U+0000-00FF;
            }
        "#;
        let url = pick_latin_woff2_url(css).unwrap();
        assert_eq!(url, "https://fonts.gstatic.com/s/x/y.woff2");
    }

    #[test]
    fn find_gstatic_woff2_url_ignores_offsite_urls() {
        assert!(find_gstatic_woff2_url("src: url(https://evil.example.com/x.woff2);").is_none());
        // Offsite URL first, gstatic one later in the same block — must keep
        // scanning past the non-match instead of stopping at the first url(.
        let block = r#"
            src: url(https://evil.example.com/x.woff2),
                 url("https://fonts.gstatic.com/s/x/y.woff2") format('woff2');
        "#;
        assert_eq!(
            find_gstatic_woff2_url(block),
            Some("https://fonts.gstatic.com/s/x/y.woff2")
        );
    }

    #[test]
    fn find_gstatic_woff2_url_requires_woff2_extension() {
        assert!(find_gstatic_woff2_url("url(https://fonts.gstatic.com/s/x/y.ttf)").is_none());
    }

    #[test]
    fn font_stats_in_empty_dir_returns_zero() {
        let dir = tempdir().unwrap();
        let stats = font_stats_in(dir.path()).unwrap();
        assert_eq!(stats.used_bytes, 0);
        assert_eq!(stats.font_count, 0);
    }

    #[test]
    fn font_stats_in_missing_dir_returns_zero() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let stats = font_stats_in(&missing).unwrap();
        assert_eq!(stats.used_bytes, 0);
        assert_eq!(stats.font_count, 0);
    }

    #[test]
    fn font_stats_in_counts_woff2_bytes_per_family() {
        let dir = tempdir().unwrap();
        let roboto = dir.path().join("roboto");
        let lato = dir.path().join("lato");
        fs::create_dir_all(&roboto).unwrap();
        fs::create_dir_all(&lato).unwrap();

        fs::File::create(roboto.join("400.woff2"))
            .unwrap()
            .write_all(&[0; 100])
            .unwrap();
        fs::File::create(lato.join("700.woff2"))
            .unwrap()
            .write_all(&[0; 200])
            .unwrap();
        // Non-woff2 file in a family dir should be ignored from byte sum.
        fs::File::create(lato.join("README.md"))
            .unwrap()
            .write_all(&[0; 50])
            .unwrap();

        let stats = font_stats_in(dir.path()).unwrap();
        assert_eq!(stats.font_count, 2);
        assert_eq!(stats.used_bytes, 300);
    }

    #[test]
    fn font_stats_in_counts_ttf_bytes() {
        let dir = tempdir().unwrap();
        let poppins = dir.path().join("poppins");
        fs::create_dir_all(&poppins).unwrap();

        fs::File::create(poppins.join("400.ttf"))
            .unwrap()
            .write_all(&[0; 150])
            .unwrap();

        let stats = font_stats_in(dir.path()).unwrap();
        assert_eq!(stats.font_count, 1);
        assert_eq!(
            stats.used_bytes, 150,
            ".ttf files must be counted in used_bytes"
        );
    }

    #[test]
    fn detect_font_extension_identifies_formats() {
        assert_eq!(detect_font_extension(&WOFF2_MAGIC), Some("woff2"));
        assert_eq!(detect_font_extension(&TTF_MAGIC), Some("ttf"));
        assert_eq!(detect_font_extension(&OTTO_MAGIC), Some("ttf"));
        assert_eq!(detect_font_extension(&TTCF_MAGIC), Some("ttf"));
        assert_eq!(detect_font_extension(&[0xFF, 0xFF, 0xFF, 0xFF]), None);
        assert_eq!(detect_font_extension(&[]), None);
        assert_eq!(detect_font_extension(&[0x00, 0x01, 0x00]), None); // too short
    }

    #[test]
    fn font_stats_in_counts_empty_family_dir_as_one() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("partial-download")).unwrap();
        let stats = font_stats_in(dir.path()).unwrap();
        assert_eq!(stats.font_count, 1);
        assert_eq!(stats.used_bytes, 0);
    }

    #[test]
    fn redact_api_key_strips_key_in_query_string() {
        let key = "AIzaSyFAKE_KEY_FAKE_KEY_FAKE_KEY_FAKE_K";
        let s = format!(
            "Google Fonts API request failed: error sending request for url \
             (https://www.googleapis.com/webfonts/v1/webfonts?key={key}&sort=alpha): dns error"
        );
        let cleaned = redact_api_key(&s, key);
        assert!(
            !cleaned.contains(key),
            "raw key must not survive: {cleaned}"
        );
        assert!(
            !cleaned.contains("key="),
            "the `key=` param must be stripped: {cleaned}"
        );
    }

    #[test]
    fn redact_api_key_strips_amp_form() {
        let key = "SECRET";
        let s = format!("https://example.com/?sort=alpha&key={key}");
        let cleaned = redact_api_key(&s, key);
        assert!(!cleaned.contains(key));
        assert!(!cleaned.contains("&key="));
    }

    #[test]
    fn redact_api_key_falls_back_to_bare_replace() {
        let key = "SECRET";
        let cleaned = redact_api_key(&format!("dump: {key}"), key);
        assert!(!cleaned.contains(key));
        assert!(cleaned.contains("[REDACTED]"));
    }

    #[test]
    fn redact_api_key_no_op_for_empty_key() {
        // Defensive: never panic or produce empty replacements when the key
        // happens to be empty (would otherwise wipe every char position).
        let cleaned = redact_api_key("hello", "");
        assert_eq!(cleaned, "hello");
    }

    #[test]
    fn sanitize_catalog_entry_keeps_valid_row() {
        let mut files = std::collections::HashMap::new();
        files.insert(
            "regular".to_string(),
            "https://fonts.gstatic.com/s/roboto/regular.ttf".to_string(),
        );
        let item = GFApiItem {
            family: "Roboto".to_string(),
            category: "sans-serif".to_string(),
            variants: vec!["regular".to_string()],
            files,
        };
        let entry = sanitize_catalog_entry(item).expect("valid row must survive");
        assert_eq!(entry.family, "Roboto");
        assert_eq!(entry.files.len(), 1);
    }

    #[test]
    fn sanitize_catalog_entry_rejects_bad_family() {
        let mut files = std::collections::HashMap::new();
        files.insert(
            "regular".to_string(),
            "https://fonts.gstatic.com/s/x/regular.ttf".to_string(),
        );
        let item = GFApiItem {
            family: "../etc/passwd".to_string(),
            category: "sans-serif".to_string(),
            variants: vec!["regular".to_string()],
            files,
        };
        assert!(sanitize_catalog_entry(item).is_none());
    }

    #[test]
    fn sanitize_catalog_entry_drops_offsite_urls() {
        let mut files = std::collections::HashMap::new();
        files.insert(
            "regular".to_string(),
            "https://evil.example.com/payload.ttf".to_string(),
        );
        files.insert(
            "700".to_string(),
            "https://fonts.gstatic.com/s/roboto/bold.ttf".to_string(),
        );
        let item = GFApiItem {
            family: "Roboto".to_string(),
            category: "sans-serif".to_string(),
            variants: vec!["regular".to_string(), "700".to_string()],
            files,
        };
        let entry = sanitize_catalog_entry(item).expect("kept by surviving 700 variant");
        assert_eq!(entry.files.len(), 1, "evil URL must be dropped");
        assert!(entry.files.contains_key("700"));
    }

    #[test]
    fn sanitize_catalog_entry_rejects_when_no_safe_urls_remain() {
        let mut files = std::collections::HashMap::new();
        files.insert(
            "regular".to_string(),
            "https://evil.example.com/payload.ttf".to_string(),
        );
        let item = GFApiItem {
            family: "Roboto".to_string(),
            category: "sans-serif".to_string(),
            variants: vec!["regular".to_string()],
            files,
        };
        assert!(sanitize_catalog_entry(item).is_none());
    }
}
