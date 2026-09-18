//! In-app updater: resolve the release channel's `latest.json` endpoint, ask
//! the updater plugin whether a newer build exists, and install it on demand.
//!
//! One binary serves both channels: the endpoint is chosen at runtime from the
//! user's setting and overrides the one baked into `tauri.conf.json`.
//!
//! Installing and relaunching are **two** commands. `install_update` swaps the
//! bundle on disk and returns, so the download runs in the background while the
//! user keeps working; the relaunch happens only when the user asks for it via
//! `restart_app`. An update that quits the app out from under an open editor is
//! worse than an update applied on the next ordinary launch.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The plugin's `.check()` has no timeout of its own, and it runs on the
/// startup path: a hung endpoint would strand the user in a "checking…" modal.
/// The download is deliberately left unbounded — `Update` is built with
/// `timeout: None` regardless of the builder, and a reqwest timeout covers the
/// *whole* request, so any cap would abort a large install on a slow link.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// `stable` never sees a prerelease: GitHub's `/releases/latest` redirect
/// excludes them, so no second workflow and no moving tag is needed.
const STABLE_ENDPOINT: &str =
    "https://github.com/dinhanhthi/memlore/releases/latest/download/latest.json";

/// Newest release *including* prereleases — `per_page=1` on the unfiltered
/// list endpoint, which is ordered newest-first.
const BETA_RELEASES_API: &str =
    "https://api.github.com/repos/dinhanhthi/memlore/releases?per_page=1";

/// What the frontend gets back. A plain serde struct so `src/` never imports
/// the updater plugin's JS API (the Vite `tauriAliasGuard` would reject it).
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

/// The `Update` handle returned by the last successful `check_for_update`.
///
/// `install_update` takes no channel argument, so it cannot re-run the check
/// itself; stashing the handle also avoids a second network round-trip and
/// guarantees the user installs exactly the build they were shown.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    Stable,
    Beta,
}

/// Unknown channel strings are an error, never a silent fall back to stable —
/// a typo must surface instead of quietly pinning the user to another channel.
fn parse_channel(channel: &str) -> Result<Channel, String> {
    match channel {
        "stable" => Ok(Channel::Stable),
        "beta" => Ok(Channel::Beta),
        other => Err(format!("unknown update channel: {other}")),
    }
}

/// `^v\d+\.\d+\.\d+(-(beta|rc)\.\d+)?$`, hand-rolled — this crate is
/// deliberately regex-free (see `utils::geocoding`).
///
/// **The tag is untrusted network input.** It is interpolated into a download
/// URL, so anything outside this shape is rejected rather than escaped.
fn is_valid_tag(tag: &str) -> bool {
    let Some(rest) = tag.strip_prefix('v') else {
        return false;
    };
    let (core, suffix) = match rest.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (rest, None),
    };

    // Capped at 5 digits per component: a real version never needs more, and an
    // unbounded digit run is free room for a hostile tag to grow in.
    let digits = |s: &str| !s.is_empty() && s.len() <= 5 && s.bytes().all(|b| b.is_ascii_digit());

    let mut parts = core.split('.');
    let core_ok = matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(a), Some(b), Some(c), None) if digits(a) && digits(b) && digits(c)
    );
    if !core_ok {
        return false;
    }

    match suffix {
        None => true,
        Some(s) => match s.split_once('.') {
            Some((kind, num)) => matches!(kind, "beta" | "rc") && digits(num),
            None => false,
        },
    }
}

/// Build the beta channel's `latest.json` URL from a release tag.
fn beta_endpoint(tag: &str) -> Result<String, String> {
    if !is_valid_tag(tag) {
        return Err(format!("rejected malformed release tag: {tag}"));
    }
    Ok(format!(
        "https://github.com/dinhanhthi/memlore/releases/download/{tag}/latest.json"
    ))
}

/// Take the stashed `Update` handle out of managed state, or replace it.
/// Both commands go through here so poisoning is handled the same way.
fn pending<R: Runtime>(app: &AppHandle<R>) -> State<'_, PendingUpdate> {
    app.state::<PendingUpdate>()
}

/// Forget the stashed handle. Called before anything fallible in a check so a
/// failed (or channel-switched) check can never leave an older build
/// installable.
fn clear_pending<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    *pending(app).0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// GitHub rejects API requests without a User-Agent. Same shape as the
/// geocoding client so outbound traffic is attributable to one identifier.
fn user_agent() -> String {
    format!(
        "Memlore/{} (https://github.com/dinhanhthi/memlore)",
        env!("CARGO_PKG_VERSION")
    )
}

/// `time::OffsetDateTime`'s `Display` is not `Date`-parseable in JS; hand the
/// frontend RFC 3339 instead, via the `chrono` already in the tree.
fn rfc3339_from_unix(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0).map(|dt| dt.to_rfc3339())
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
}

/// Newest release tag on the beta channel (prereleases included).
async fn latest_beta_tag() -> Result<String, String> {
    // Without an explicit timeout reqwest waits forever; this pre-flight sits
    // on the app's startup path, so a hung GitHub would hang the check.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let releases: Vec<GithubRelease> = client
        .get(BETA_RELEASES_API)
        .header("User-Agent", user_agent())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    releases
        .into_iter()
        .next()
        .map(|r| r.tag_name)
        .ok_or_else(|| "no releases published yet".to_string())
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
) -> Result<Option<UpdateInfo>, String> {
    // First thing, before any `?`: the handle we may be about to replace must
    // not outlive this call if it fails half way.
    clear_pending(&app)?;

    // Dev builds never reach the network: `pnpm tauri dev` runs against a
    // version that is not on GitHub, and the check would be noise at best.
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let url = match parse_channel(&channel)? {
        Channel::Stable => STABLE_ENDPOINT.to_string(),
        Channel::Beta => beta_endpoint(&latest_beta_tag().await?)?,
    };
    let url = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let Some(update) = update else {
        return Ok(None);
    };

    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        pub_date: update
            .date
            .and_then(|d| rfc3339_from_unix(d.unix_timestamp())),
    };
    *pending(&app).0.lock().map_err(|e| e.to_string())? = Some(update);
    Ok(Some(info))
}

/// Download and install the build the last `check_for_update` found, then
/// return. **It does not relaunch** — on macOS `download_and_install` swaps the
/// bundle without touching the running process, so the user stays in their
/// session and the new version takes effect on the next launch (either
/// `restart_app`, or an ordinary quit-and-reopen).
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Take the handle out and drop the guard before awaiting — a std
    // `MutexGuard` is not `Send` and cannot be held across `.await`.
    let update = {
        let state = pending(&app);
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        slot.take()
            .ok_or_else(|| "no pending update — run check_for_update first".to_string())?
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Relaunch into the freshly installed build. The only exit point of an
/// update, and always user-initiated (the "Restart" button on the
/// update-ready card) — never called by `install_update`.
///
/// `AppHandle::restart` is `-> !`: it does not return, so the `Ok` is
/// unreachable and exists only to keep the command's signature uniform with
/// every other one.
#[tauri::command]
pub fn restart_app<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.restart()
}

/// The running build's version, straight from `tauri.conf.json` via the
/// embedded package info. Shown on the About page so a bug report can name
/// the exact build. `Result` for consistency with every other command.
#[tauri::command]
pub fn app_version<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_endpoint_points_at_the_latest_release() {
        assert_eq!(
            STABLE_ENDPOINT,
            "https://github.com/dinhanhthi/memlore/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn beta_endpoint_is_built_from_the_release_tag() {
        assert_eq!(
            beta_endpoint("v0.2.0-beta.1").unwrap(),
            "https://github.com/dinhanhthi/memlore/releases/download/v0.2.0-beta.1/latest.json"
        );
        assert_eq!(
            beta_endpoint("v0.1.0").unwrap(),
            "https://github.com/dinhanhthi/memlore/releases/download/v0.1.0/latest.json"
        );
    }

    #[test]
    fn valid_tags_are_accepted() {
        for tag in ["v0.1.0", "v0.2.0-beta.1", "v1.0.0-rc.2", "v10.20.30"] {
            assert!(is_valid_tag(tag), "{tag} must be accepted");
        }
    }

    #[test]
    fn hostile_or_malformed_tags_are_rejected() {
        for tag in [
            "../../evil",
            "v1.0.0 && rm -rf /",
            "latest",
            "v1.0",
            "",
            "v1.0.0.0",
            "0.1.0",
            "v1.0.0-alpha.1",
            "v1.0.0-beta",
            "v1.0.0-beta.x",
            "v1.0.0/../../evil",
            "v1.0.0\n",
            // Percent-encoded traversal: the tag lands in a URL path, so a
            // decoder downstream must not get a second chance at it.
            "v1.0.0%2F..%2F..%2Fevil",
            "v1.0.0%0A",
            // Host swap — an absolute URL where a tag is expected.
            "v1.0.0@evil.example.com",
            "https://evil.example.com/v1.0.0",
            // Two suffix segments, and a suffix that re-opens the shape.
            "v1.0.0-beta.1-rc.2",
            "v1.0.0-beta.1.2",
            // Non-ASCII digits that some parsers treat as numeric.
            "v١.٠.٠",
            "v1.0.٠",
            // Whitespace only, and a query/fragment tacked on.
            "   ",
            "v1.0.0?x=1",
            "v1.0.0#frag",
        ] {
            assert!(!is_valid_tag(tag), "{tag:?} must be rejected");
        }
    }

    #[test]
    fn a_rejected_tag_never_produces_a_url() {
        let err = beta_endpoint("../../evil").unwrap_err();
        assert!(!err.contains("releases/download"), "leaked a URL: {err}");
    }

    #[test]
    fn channels_parse_and_unknown_ones_error() {
        assert_eq!(parse_channel("stable").unwrap(), Channel::Stable);
        assert_eq!(parse_channel("beta").unwrap(), Channel::Beta);
        for bad in ["", "Stable", "nightly", "alpha"] {
            assert!(parse_channel(bad).is_err(), "{bad:?} must not be accepted");
        }
    }

    #[test]
    fn pub_date_is_rfc3339() {
        assert_eq!(
            rfc3339_from_unix(1_757_894_400).unwrap(),
            "2025-09-15T00:00:00+00:00"
        );
    }

    #[test]
    fn version_components_are_capped_at_five_digits() {
        assert!(is_valid_tag("v99999.0.0"));
        assert!(is_valid_tag("v1.0.0-beta.99999"));
        for tag in [
            "v123456.0.0",
            "v1.123456.0",
            "v1.0.123456",
            "v1.0.0-beta.123456",
            // A leading-zero pad is how a cap gets walked around.
            "v0000001.0.0",
        ] {
            assert!(!is_valid_tag(tag), "{tag} must be rejected");
        }
    }

    #[test]
    fn check_timeout_is_bounded() {
        // The plugin's `.check()` has no timeout of its own; without this the
        // user sits in an undismissable "checking…" modal forever.
        assert!(
            CHECK_TIMEOUT.as_secs() > 0 && CHECK_TIMEOUT.as_secs() <= 60,
            "got {CHECK_TIMEOUT:?}"
        );
    }

    #[test]
    fn app_version_matches_the_running_package_info() {
        let app = crate::test_support::mock_app::mock_app();
        let version = app_version(app.handle().clone()).expect("app_version");
        assert!(!version.is_empty(), "version must not be empty");
        assert_eq!(version, app.package_info().version.to_string());
    }

    /// The install command refuses to run without a handle from a successful
    /// check — this is what makes a double-install (or a stale slot after a
    /// channel switch) an error instead of installing the wrong build.
    #[tokio::test]
    async fn install_update_without_a_pending_handle_errors() {
        let app = crate::test_support::mock_app::mock_app();
        let err = install_update(app.handle().clone())
            .await
            .expect_err("empty slot must error");
        assert!(err.contains("no pending update"), "got {err}");
    }

    /// `check_for_update` runs this before its first `?`, so a failed or
    /// channel-switched check can never leave an older build installable.
    /// (A stale `Some(Update)` cannot be seeded here: the plugin's `Update` has
    /// private fields, so the ordering itself is enforced by construction.)
    #[tokio::test]
    async fn clearing_the_pending_slot_leaves_nothing_installable() {
        let app = crate::test_support::mock_app::mock_app();
        clear_pending(app.handle()).expect("clear_pending");
        assert!(pending(app.handle()).0.lock().unwrap().is_none());

        check_for_update(app.handle().clone(), "stable".into())
            .await
            .expect("dev-build check is a no-op");
        let err = install_update(app.handle().clone())
            .await
            .expect_err("nothing to install");
        assert!(err.contains("no pending update"), "got {err}");
    }

    // `restart_app` has no test: `AppHandle::restart` terminates the process,
    // so calling it here would kill the test runner. Its whole body is that one
    // call, and it is registered in `generate_handler!` next to the others.

    #[test]
    fn user_agent_identifies_memlore() {
        let ua = user_agent();
        assert!(ua.starts_with("Memlore/"), "got {ua}");
        assert!(ua.contains("github.com/dinhanhthi/memlore"), "got {ua}");
    }
}
