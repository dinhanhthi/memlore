//! Complete local uninstall — erase every on-disk trace of Memlore from the
//! current machine and, on macOS, remove the application bundle itself.
//!
//! # Why a reaper process
//!
//! The command cannot finish the job in-process: on Windows the open SQLCipher
//! handle pins `memlore.db`, and on macOS deleting the still-running `.app`
//! risks a lazy dyld load from a bundle that no longer exists. So
//! [`uninstall_app`] does the bookkeeping in-process (schedulers, Keychain,
//! login item), spawns a detached **reaper** that waits for this PID to exit,
//! and then quits.
//!
//! # Why the reaper takes no files
//!
//! The script is passed on `sh -c` and the targets arrive as `argv`, so nothing
//! this module produces ever lands on disk. An earlier design staged a script
//! and a NUL-separated target list in `std::env::temp_dir()`; on Linux that is
//! `/tmp`, and a local attacker who guessed the PID-derived filename could
//! either plant a symlink before the write or swap the file in the window
//! before `sh` opened it — yielding code execution as the user, and (worse)
//! letting them substitute the target list, which would have voided every
//! guarantee below. `argv` has no such window.
//!
//! # Safety
//!
//! The reaper runs `rm -rf` (or `Directory.Delete`) over whatever we hand it,
//! so the load-bearing code here is [`is_safe_data_path`],
//! [`is_safe_temp_path`] and [`is_safe_bundle_path`]. All three are positive
//! allow-lists: a data target must live under `$HOME`, be at least two
//! components deep below it, and its leaf must be exactly one of the three
//! names the app owns. A temp target must sit directly in the system temp dir
//! and match one of the app's own file-name shapes. A bundle target must be a
//! `*.app` named after the product and must not be an App Translocation mount.
//!
//! # Reporting
//!
//! Deletion is retried, then verified. Anything still present is written to
//! `$HOME/memlore-uninstall-failed.log` — the app is gone by then, so a file
//! the user can find is the only channel left. Silence means success.
//!
//! # Out of scope
//!
//! Cloud data (Google Drive appdata, the iCloud/local sync folder) is shared
//! with the user's other devices and is never touched here — Settings → Sync
//! owns that. On Windows and Linux the application binary is left in place:
//! removing it correctly means the NSIS/MSI uninstaller or the package manager.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Bundle directory name on macOS. Matches `productName` in `tauri.conf.json`.
const MAC_BUNDLE_NAME: &str = "Memlore.app";

/// Seconds the reaper waits for this process to exit. On timeout it deletes
/// **nothing** and reports — pulling files out from under a live app is worse
/// than an uninstall that visibly did not happen.
const REAPER_WAIT_SECS: u32 = 60;

/// Delete passes. Repeats catch files that `cfprefsd` or the WebKit networking
/// process flush back moments after the app exits.
const REAPER_PASSES: u32 = 3;

/// Written under `$HOME` when the reaper cannot finish. Not localized: nothing
/// is left running to translate it.
const FAILURE_LOG_NAME: &str = "memlore-uninstall-failed.log";

/// Minimum number of path components a data target must have *below* `$HOME`.
/// `~/.config/app.memlore` is the shallowest real case (2).
const MIN_DEPTH_BELOW_HOME: usize = 2;

/// What [`uninstall_app`] will erase, for the confirmation dialog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPreview {
    /// Absolute data paths that will be deleted, in deletion order.
    pub paths: Vec<String>,
    /// Paths that exist and belong to the app but fail the safety rules, so
    /// they will survive. Non-empty means the wipe is knowingly incomplete —
    /// the UI must say so rather than promise total erasure.
    pub skipped: Vec<String>,
    /// Total on-disk size of `paths`.
    pub total_bytes: u64,
    /// The application bundle, when this platform + install can remove it.
    pub app_path: Option<String>,
    /// `true` only when `app_path` is present and its parent is writable.
    pub app_removable: bool,
    /// `"macos"` | `"windows"` | `"linux"` | `"other"`.
    pub platform: &'static str,
}

/// Accepted and rejected candidates from one filtering pass.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct TargetPlan {
    pub accepted: Vec<PathBuf>,
    /// Existing candidates the allow-list refused. Surfaced, never deleted.
    pub skipped: Vec<PathBuf>,
}

pub(crate) fn platform_id() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Reject any path that is not already normalized. `..` in a target would let a
/// symlinked or relative segment escape the `$HOME` prefix check below.
///
/// `Path::is_absolute` encodes the platform rule — on Windows it requires a
/// prefix *and* a root, so the drive-relative `C:foo\bar` is correctly refused.
fn is_normalized_absolute(p: &Path) -> bool {
    p.is_absolute()
        && p.components()
            .all(|c| !matches!(c, Component::ParentDir | Component::CurDir))
}

/// The three leaf names the app owns under `$HOME`.
fn owned_leaf_names(identifier: &str) -> [String; 3] {
    [
        identifier.to_owned(),
        format!("{identifier}.plist"),
        format!("{identifier}.savedState"),
    ]
}

/// Positive allow-list for a deletable **data** path.
///
/// Requires: absolute + normalized, strictly below `home`, at least
/// [`MIN_DEPTH_BELOW_HOME`] components below it, and a leaf that is *exactly*
/// one of [`owned_leaf_names`]. Exact rather than prefix matching, so a user's
/// own `app.memlore.backup` can never qualify.
pub(crate) fn is_safe_data_path(p: &Path, home: &Path, identifier: &str) -> bool {
    if identifier.is_empty() || !is_normalized_absolute(p) || !is_normalized_absolute(home) {
        return false;
    }
    let Ok(rel) = p.strip_prefix(home) else {
        return false;
    };
    if rel.components().count() < MIN_DEPTH_BELOW_HOME {
        return false;
    }
    let Some(leaf) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    owned_leaf_names(identifier).iter().any(|n| n == leaf)
}

/// Positive allow-list for the app's own scratch files in the system temp dir.
///
/// These hold **decrypted** user content — `audio.rs` writes raw voice memos,
/// `import.rs` stages imported media, `media.rs` writes transcodes — so leaving
/// them behind would falsify the "no copy is kept" promise the dialog makes.
/// They live outside `$HOME`, so [`is_safe_data_path`] can never admit them;
/// this is the narrow second door. The leaf must match a shape the app itself
/// produces and the parent must be exactly `temp`.
pub(crate) fn is_safe_temp_path(p: &Path, temp: &Path) -> bool {
    if !is_normalized_absolute(p) || p.parent() != Some(temp) {
        return false;
    }
    let Some(leaf) = p.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    leaf == "memlore-import-media"
        || (leaf.starts_with("memlore_memo_") && leaf.ends_with(".wav"))
        || (leaf.starts_with("xj-transcode-") && leaf.ends_with(".mp4"))
}

/// Positive allow-list for the application bundle.
///
/// Rejects App Translocation mounts: a bundle launched straight from a DMG or
/// quarantined download runs from a read-only `/private/var/.../
/// AppTranslocation/<uuid>/d/` copy, and deleting that erases a shadow, not the
/// install.
pub(crate) fn is_safe_bundle_path(p: &Path) -> bool {
    if !is_normalized_absolute(p) {
        return false;
    }
    if p.components().any(|c| c.as_os_str() == "AppTranslocation") {
        return false;
    }
    // Must have a real parent — never a bundle sitting at a filesystem root.
    match p.parent() {
        None => return false,
        Some(parent) if parent.components().count() <= 1 => return false,
        Some(_) => {}
    }
    p.file_name().is_some_and(|n| n == MAC_BUNDLE_NAME)
}

/// Walk up from the running executable to the enclosing `.app` bundle.
///
/// Returns `None` outside a bundle — which is exactly the `pnpm tauri dev` case
/// (`target/debug/memlore`), so a dev run can never offer to delete itself.
///
/// `find(is .app).filter(is_safe)` and NOT `filter(...).find(...)`: the first
/// `.app` ancestor is the only candidate, and if it fails the safety rules the
/// answer is `None`, never "keep walking up to some outer bundle".
pub(crate) fn bundle_root_from_exe(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|a| a.extension().is_some_and(|e| e == "app"))
        .filter(|a| is_safe_bundle_path(a))
        .map(Path::to_path_buf)
}

/// Split `candidates` into safe-and-present versus present-but-refused.
///
/// Order is preserved (the caller lists the vault directory first) and
/// duplicates are dropped — several Tauri path-resolver getters collapse to the
/// same directory on Linux.
pub(crate) fn plan_targets(
    candidates: &[PathBuf],
    home: &Path,
    temp: &Path,
    identifier: &str,
) -> TargetPlan {
    let mut seen = BTreeSet::new();
    let mut plan = TargetPlan::default();
    for p in candidates {
        if p.symlink_metadata().is_err() || !seen.insert(p.clone()) {
            continue;
        }
        if is_safe_data_path(p, home, identifier) || is_safe_temp_path(p, temp) {
            plan.accepted.push(p.clone());
        } else {
            // Exists, came from our own candidate list, but the allow-list said
            // no — e.g. an XDG dir pointed outside $HOME. The user must be told.
            plan.skipped.push(p.clone());
        }
    }
    plan
}

/// Every location the app may have written to, before safety filtering.
///
/// The Tauri resolver covers data/config/cache/log; the macOS extras are
/// WebKit's website data, the window-restore blob, and the preferences plist.
/// The temp entries are enumerated because their names carry a UUID.
fn candidate_paths(app: &AppHandle, home: &Path, temp: &Path, identifier: &str) -> Vec<PathBuf> {
    let resolver = app.path();
    let mut out: Vec<PathBuf> = [
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_config_dir(),
        resolver.app_cache_dir(),
        resolver.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();

    if cfg!(target_os = "macos") {
        let library = home.join("Library");
        out.push(library.join("WebKit").join(identifier));
        out.push(library.join("HTTPStorages").join(identifier));
        out.push(
            library
                .join("Saved Application State")
                .join(format!("{identifier}.savedState")),
        );
        out.push(
            library
                .join("Preferences")
                .join(format!("{identifier}.plist")),
        );
    }

    // Decrypted scratch content. `is_safe_temp_path` re-checks every entry, so
    // a hostile name in the temp dir cannot ride along.
    if let Ok(entries) = std::fs::read_dir(temp) {
        for entry in entries.flatten() {
            let p = entry.path();
            if is_safe_temp_path(&p, temp) {
                out.push(p);
            }
        }
    }
    out
}

/// Recursive on-disk size, iteratively — a hostile or merely deep tree must not
/// overflow the stack. Symlinks are counted as their own (tiny) entry and never
/// followed, so a link into the user's photo library cannot inflate the number
/// the confirmation dialog shows.
fn path_size(p: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(meta) = cur.symlink_metadata() else {
            continue;
        };
        total = total.saturating_add(meta.len());
        if !meta.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&cur) {
            stack.extend(entries.flatten().map(|e| e.path()));
        }
    }
    total
}

/// Can this user actually unlink entries from `dir`?
///
/// NOT `Permissions::readonly()`, which on Unix means "nobody has any write
/// bit" — `/Applications` is typically `drwxrwxr-x root:admin`, so `readonly()`
/// reports `false` even for a standard user who is not in `admin` and cannot
/// unlink there at all. `access(2)` answers the question actually being asked.
fn dir_is_writable(dir: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `c` is a valid NUL-terminated C string that outlives the call.
        unsafe { libc::access(c.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        dir.metadata().is_ok_and(|m| !m.permissions().readonly())
    }
}

fn resolve_home(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|e| format!("uninstall: failed to resolve home dir: {e}"))
}

fn build_preview(app: &AppHandle) -> Result<UninstallPreview, String> {
    let home = resolve_home(app)?;
    let temp = std::env::temp_dir();
    let identifier = app.config().identifier.clone();
    let plan = plan_targets(
        &candidate_paths(app, &home, &temp, &identifier),
        &home,
        &temp,
        &identifier,
    );
    let total_bytes = plan.accepted.iter().map(|p| path_size(p)).sum();

    let bundle = std::env::current_exe()
        .ok()
        .and_then(|exe| bundle_root_from_exe(&exe));
    let app_removable = bundle
        .as_ref()
        .and_then(|b| b.parent())
        .is_some_and(dir_is_writable);

    Ok(UninstallPreview {
        paths: plan
            .accepted
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        skipped: plan
            .skipped
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        total_bytes,
        app_path: bundle.map(|b| b.to_string_lossy().into_owned()),
        app_removable,
        platform: platform_id(),
    })
}

/// Report exactly what an uninstall would erase. Read-only.
///
/// `async` + `spawn_blocking`: the size walk `stat`s the whole media tree
/// (gigabytes in practice) and a sync `#[tauri::command]` runs inline on the
/// main thread, freezing the window. Matches `sync.rs` / `crypto.rs`.
#[tauri::command]
pub async fn uninstall_preview(app: AppHandle) -> Result<UninstallPreview, String> {
    tauri::async_runtime::spawn_blocking(move || build_preview(&app))
        .await
        .map_err(|e| format!("uninstall: preview task failed: {e}"))?
}

/// `ps -o lstart=` for `pid`, used to defeat PID reuse in the reaper loop.
/// Empty string when unavailable — the loop then falls back to liveness only.
#[cfg(unix)]
fn process_start_stamp(pid: u32) -> String {
    // Absolute path: a planted `ps` earlier on PATH could otherwise spoof the
    // liveness check the reaper depends on.
    std::process::Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

/// Single-quote a value for POSIX `sh`. Applied only to values interpolated
/// into script source — never to target paths, which travel as `argv`.
#[cfg(unix)]
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// POSIX reaper source, for `sh -c`.
///
/// Targets are **not** in this string: the caller appends them as `argv`, so
/// `"$@"` is the only way a path enters. `$1` is the failure-log path.
///
/// `PATH` is pinned before anything runs — `/usr/local/bin` is admin-writable
/// on macOS and normally precedes `/usr/bin`, so a planted `rm` would otherwise
/// execute here, at the exact moment the user authorised destruction.
///
/// The poll is `sleep 1`, never fractional: POSIX defines `sleep` with an
/// integer operand only, and on a busybox `sh` a rejected `sleep 0.2` would
/// burn all iterations in microseconds and start deleting under a live app.
#[cfg(unix)]
pub(crate) fn render_reaper_unix(pid: u32, start_stamp: &str) -> String {
    format!(
        r#"PATH=/usr/bin:/bin
export PATH
PID={pid}
START={start}
LOG=$1
shift
EXITED=0
i=0
while [ "$i" -lt {wait_secs} ]; do
  if ! kill -0 "$PID" 2>/dev/null; then EXITED=1; break; fi
  if [ -n "$START" ]; then
    CUR=$(ps -o lstart= -p "$PID" 2>/dev/null | sed 's/^ *//;s/ *$//')
    if [ "$CUR" != "$START" ]; then EXITED=1; break; fi
  fi
  sleep 1
  i=$((i+1))
done
if [ "$EXITED" -ne 1 ]; then
  printf 'Memlore uninstall aborted: the app was still running after {wait_secs}s. Nothing was deleted.\n' > "$LOG"
  exit 1
fi
n=0
while [ "$n" -lt {passes} ]; do
  for t in "$@"; do rm -rf -- "$t"; done
  n=$((n+1))
  [ "$n" -lt {passes} ] && sleep 1
done
FAILED=
for t in "$@"; do
  if [ -e "$t" ]; then FAILED="$FAILED$t
"; fi
done
if [ -n "$FAILED" ]; then
  printf 'Memlore uninstall could not remove:\n%s' "$FAILED" > "$LOG"
  exit 1
fi
exit 0
"#,
        pid = pid,
        start = sh_quote(start_stamp),
        wait_secs = REAPER_WAIT_SECS,
        passes = REAPER_PASSES,
    )
}

/// Single-quote a value for PowerShell (doubling is the only escape needed
/// inside a single-quoted string; newlines are literal and harmless).
#[cfg(windows)]
pub(crate) fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// PowerShell reaper source, for `-Command`.
///
/// Targets are embedded as a quoted array literal rather than read from a file:
/// the previous `Get-Content` design split on newlines, so a path containing
/// one became two bogus paths.
///
/// Deletion uses `[System.IO.Directory]::Delete($p, $true)`, not
/// `Remove-Item -Recurse`, because Windows PowerShell 5.1's `Remove-Item`
/// traverses junctions and reparse points and deletes their *contents* —
/// a media directory relocated to a second drive would take out data outside
/// the target set. `Directory.Delete` removes the junction itself.
#[cfg(windows)]
pub(crate) fn render_reaper_windows(
    pid: u32,
    start_ticks: Option<i64>,
    log_path: &Path,
    targets: &[PathBuf],
) -> String {
    let list = targets
        .iter()
        .map(|t| ps_quote(&t.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(",");
    // PID-reuse guard, mirroring the Unix `ps -o lstart=` comparison.
    let guard = match start_ticks {
        Some(ticks) => format!(
            "$p = Get-Process -Id {pid}; \
             if ($p -and $p.StartTime.Ticks -eq {ticks}) {{ Wait-Process -Id {pid} -Timeout {wait} }}\n\
             $alive = $false; $q = Get-Process -Id {pid}; \
             if ($q -and $q.StartTime.Ticks -eq {ticks}) {{ $alive = $true }}",
            pid = pid,
            ticks = ticks,
            wait = REAPER_WAIT_SECS,
        ),
        None => format!(
            "Wait-Process -Id {pid} -Timeout {wait}\n$alive = [bool](Get-Process -Id {pid})",
            pid = pid,
            wait = REAPER_WAIT_SECS,
        ),
    };
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$log = {log}
$targets = @({list})
{guard}
if ($alive) {{
  Set-Content -LiteralPath $log -Value 'Memlore uninstall aborted: the app was still running after {wait}s. Nothing was deleted.'
  exit 1
}}
for ($n = 0; $n -lt {passes}; $n++) {{
  foreach ($t in $targets) {{
    if (Test-Path -LiteralPath $t) {{
      $item = Get-Item -LiteralPath $t -Force
      if ($item.PSIsContainer) {{ [System.IO.Directory]::Delete($t, $true) }}
      else {{ [System.IO.File]::Delete($t) }}
    }}
  }}
  if ($n -lt {passes} - 1) {{ Start-Sleep -Seconds 1 }}
}}
$failed = @($targets | Where-Object {{ Test-Path -LiteralPath $_ }})
if ($failed.Count -gt 0) {{
  Set-Content -LiteralPath $log -Value (@('Memlore uninstall could not remove:') + $failed)
  exit 1
}}
exit 0
"#,
        log = ps_quote(&log_path.to_string_lossy()),
        list = list,
        guard = guard,
        passes = REAPER_PASSES,
        wait = REAPER_WAIT_SECS,
    )
}

#[cfg(windows)]
fn process_start_ticks(pid: u32) -> Option<i64> {
    let out = std::process::Command::new(powershell_path())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid}).StartTime.Ticks"),
        ])
        .output()
        .ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}

/// Absolute interpreter path — `CreateProcess`'s search order includes the
/// application directory, so a bare `powershell.exe` is hijackable.
#[cfg(windows)]
fn powershell_path() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// Start the detached reaper. Returns once the child is spawned; it outlives us.
fn spawn_reaper(targets: &[PathBuf], log_path: &Path) -> Result<(), String> {
    let pid = std::process::id();

    #[cfg(unix)]
    {
        let script = render_reaper_unix(pid, &process_start_stamp(pid));
        // `sh -c SCRIPT sh LOG TARGET...` — the second `sh` becomes `$0`, the
        // log becomes `$1`, and every target lands in `"$@"` after the shift.
        // No target is ever interpolated into shell source.
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(script).arg("sh").arg(log_path);
        for t in targets {
            cmd.arg(t);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("uninstall: failed to spawn reaper: {e}"))?;
        Ok(())
    }

    #[cfg(windows)]
    {
        let script = render_reaper_windows(pid, process_start_ticks(pid), log_path, targets);
        std::process::Command::new(powershell_path())
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
            ])
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("uninstall: failed to spawn reaper: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (targets, log_path, pid);
        Err("uninstall: unsupported platform".to_string())
    }
}

/// Stop every background worker that could write to the DB or the media dir
/// after the reaper starts. All are best-effort: a missing state just means
/// that subsystem never started.
fn stop_background_workers(app: &AppHandle) {
    if let Some(s) = app.try_state::<crate::sync::scheduler::SyncScheduler>() {
        s.stop();
    }
    if let Some(s) = app.try_state::<crate::reminders::scheduler::ReminderScheduler>() {
        s.stop();
    }
    if let Some(q) = app.try_state::<crate::commands::compression::CompressionQueue>() {
        q.stop();
    }
    if let Some(mgr) =
        app.try_state::<std::sync::Arc<crate::ai::on_device::server::LlamaServerManager>>()
    {
        mgr.kill_sync();
    }
}

/// Clear the login item so a deleted app cannot be relaunched at next boot.
fn disable_autostart(app: &AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        if let Err(e) = app.autolaunch().disable() {
            log::warn!("uninstall: failed to disable autostart: {e}");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let _ = app;
}

/// Native OS confirmation. This is the real authority check.
///
/// `uninstall_app` is reachable by name from any JavaScript in the webview, and
/// the typed-`Memlore` gate lives entirely in React state — an injected script
/// (a compromised dependency, an `'unsafe-eval'` gadget) could invoke the
/// command directly and destroy the vault with no prompt. Renderer code cannot
/// click an OS-owned dialog, so this closes that hole; the in-app ceremony
/// stays as the considered, informative gate.
fn confirm_natively(app: &AppHandle, paths: usize) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(format!(
            "This permanently erases {paths} location(s) of Memlore data on this computer, \
             including your encrypted journal. It cannot be undone."
        ))
        .title("Erase all Memlore data?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Erase everything".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

fn run_uninstall(app: &AppHandle, remove_app_bundle: bool) -> Result<(), String> {
    let home = resolve_home(app)?;
    let temp = std::env::temp_dir();
    let identifier = app.config().identifier.clone();
    let plan = plan_targets(
        &candidate_paths(app, &home, &temp, &identifier),
        &home,
        &temp,
        &identifier,
    );
    let mut targets = plan.accepted;

    if remove_app_bundle {
        if let Some(bundle) = std::env::current_exe()
            .ok()
            .and_then(|exe| bundle_root_from_exe(&exe))
        {
            // Last, so a failed bundle delete cannot strand the data.
            targets.push(bundle);
        }
    }

    if targets.is_empty() {
        return Err("uninstall: nothing to remove".to_string());
    }

    if !confirm_natively(app, targets.len()) {
        return Err("uninstall: cancelled".to_string());
    }

    // Spawn FIRST. Everything below is irreversible, and `spawn_reaper` is the
    // only fallible step — doing it first means a spawn failure is a clean
    // no-op instead of leaving a live app with biometric unlock destroyed and
    // its schedulers dead.
    spawn_reaper(&targets, &home.join(FAILURE_LOG_NAME))?;
    log::info!("uninstall: reaper spawned for {} target(s)", targets.len());

    stop_background_workers(app);
    disable_autostart(app);
    // Not paired with `clear_biometric_setting` (keychain.rs's documented
    // contract) on purpose: the reaper is already committed, so the DB holding
    // that setting is about to be deleted along with the boot file. There is no
    // surviving-DB path from here.
    if let Err(e) = crate::commands::keychain::wipe_biometric_keychain() {
        log::warn!("uninstall: failed to wipe biometric Keychain entry: {e}");
    }

    app.exit(0);
    Ok(())
}

/// Erase Memlore from this machine and quit.
///
/// `remove_app_bundle` is honoured only when the running executable resolves to
/// a genuine, writable `.app` bundle — see [`bundle_root_from_exe`]. A native
/// OS confirmation is required regardless of what the caller passes; there is
/// no undo.
///
/// `async`: `blocking_show` must not run on the main thread.
#[tauri::command]
pub async fn uninstall_app(app: AppHandle, remove_app_bundle: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_uninstall(&app, remove_app_bundle))
        .await
        .map_err(|e| format!("uninstall: task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "app.memlore";

    fn home() -> PathBuf {
        PathBuf::from("/Users/tester")
    }

    fn temp() -> PathBuf {
        PathBuf::from("/var/folders/ab/T")
    }

    // ── is_safe_data_path ────────────────────────────────────────────────────

    #[test]
    fn accepts_the_real_data_directories() {
        for p in [
            "/Users/tester/Library/Application Support/app.memlore",
            "/Users/tester/Library/Caches/app.memlore",
            "/Users/tester/Library/Logs/app.memlore",
            "/Users/tester/Library/WebKit/app.memlore",
            "/Users/tester/Library/HTTPStorages/app.memlore",
            "/Users/tester/Library/Saved Application State/app.memlore.savedState",
            "/Users/tester/Library/Preferences/app.memlore.plist",
            "/Users/tester/.config/app.memlore",
            "/Users/tester/.local/share/app.memlore",
        ] {
            assert!(
                is_safe_data_path(Path::new(p), &home(), ID),
                "must accept real data path {p}"
            );
        }
    }

    #[test]
    fn rejects_every_catastrophic_path() {
        for p in [
            "/",
            "/Users",
            "/Users/tester",
            "/Users/tester/Library",
            "/Users/tester/Library/Application Support",
            "/Users/tester/Documents",
            "/System",
            "/Applications",
            "/tmp/app.memlore",
            "/Users/other/Library/Caches/app.memlore",
        ] {
            assert!(
                !is_safe_data_path(Path::new(p), &home(), ID),
                "must reject {p}"
            );
        }
    }

    #[test]
    fn rejects_paths_whose_leaf_is_not_exactly_an_owned_name() {
        // A sibling directory in the very same parent must not qualify.
        assert!(!is_safe_data_path(
            Path::new("/Users/tester/Library/Caches/com.apple.Safari"),
            &home(),
            ID
        ));
        // Nor may a *child* of a real target sneak past on its parent's name.
        assert!(!is_safe_data_path(
            Path::new("/Users/tester/Library/Application Support/app.memlore/media"),
            &home(),
            ID
        ));
        // Exact-match rule: the user's own lookalike directories are safe.
        for leaf in [
            "app.memlore.evil",
            "app.memlore-backup",
            "app.memlore.old",
            "app.memloreXYZ",
        ] {
            let p = home().join("Library").join("Caches").join(leaf);
            assert!(
                !is_safe_data_path(&p, &home(), ID),
                "prefix-only leaf {leaf} must NOT qualify"
            );
        }
    }

    #[test]
    fn rejects_relative_and_dotdot_paths() {
        assert!(!is_safe_data_path(
            Path::new("Library/app.memlore"),
            &home(),
            ID
        ));
        assert!(!is_safe_data_path(
            Path::new("/Users/tester/Library/../../../etc/app.memlore"),
            &home(),
            ID
        ));
    }

    #[test]
    fn rejects_empty_identifier() {
        assert!(!is_safe_data_path(
            Path::new("/Users/tester/Library/Caches/anything"),
            &home(),
            ""
        ));
    }

    #[test]
    fn a_sibling_home_with_a_shared_prefix_is_not_inside_home() {
        // `strip_prefix` is component-wise, so /Users/tester2 must not match
        // home=/Users/tester. Guards the classic textual-prefix trap.
        assert!(!is_safe_data_path(
            Path::new("/Users/tester2/Library/Caches/app.memlore"),
            &home(),
            ID
        ));
    }

    // ── is_safe_temp_path ────────────────────────────────────────────────────

    #[test]
    fn accepts_only_the_apps_own_temp_artifacts() {
        for leaf in [
            "memlore-import-media",
            "memlore_memo_5f9c1c2e-0000-4000-8000-000000000000.wav",
            "xj-transcode-5f9c1c2e-0000-4000-8000-000000000000.mp4",
        ] {
            assert!(
                is_safe_temp_path(&temp().join(leaf), &temp()),
                "must accept own temp artifact {leaf}"
            );
        }
    }

    #[test]
    fn rejects_foreign_or_misplaced_temp_entries() {
        // Someone else's file in the same directory.
        assert!(!is_safe_temp_path(&temp().join("com.apple.stuff"), &temp()));
        // Right prefix, wrong extension — not a shape we produce.
        assert!(!is_safe_temp_path(
            &temp().join("memlore_memo_abc.mp3"),
            &temp()
        ));
        // The temp dir itself must never be a target.
        assert!(!is_safe_temp_path(&temp(), &temp()));
        // Nested one level deeper than we ever write.
        assert!(!is_safe_temp_path(
            &temp().join("sub").join("memlore-import-media"),
            &temp()
        ));
        // Same leaf, different directory.
        assert!(!is_safe_temp_path(
            Path::new("/Users/tester/memlore-import-media"),
            &temp()
        ));
    }

    // ── is_safe_bundle_path / bundle_root_from_exe ───────────────────────────

    #[test]
    fn accepts_a_normal_application_bundle() {
        assert!(is_safe_bundle_path(Path::new("/Applications/Memlore.app")));
        assert!(is_safe_bundle_path(Path::new(
            "/Users/tester/Applications/Memlore.app"
        )));
    }

    #[test]
    fn rejects_translocated_and_misnamed_bundles() {
        assert!(!is_safe_bundle_path(Path::new(
            "/private/var/folders/ab/AppTranslocation/1234/d/Memlore.app"
        )));
        assert!(!is_safe_bundle_path(Path::new("/Applications/Safari.app")));
        assert!(!is_safe_bundle_path(Path::new("/Memlore.app")));
        assert!(!is_safe_bundle_path(Path::new("relative/Memlore.app")));
    }

    #[test]
    fn bundle_root_walks_up_from_the_executable() {
        assert_eq!(
            bundle_root_from_exe(Path::new(
                "/Applications/Memlore.app/Contents/MacOS/Memlore"
            )),
            Some(PathBuf::from("/Applications/Memlore.app"))
        );
    }

    #[test]
    fn bundle_root_is_none_for_a_dev_build() {
        // `pnpm tauri dev` — the UI must never offer to delete this.
        assert_eq!(
            bundle_root_from_exe(Path::new(
                "/Users/tester/git/Memlore/src-tauri/target/debug/memlore"
            )),
            None
        );
    }

    #[test]
    fn bundle_root_is_none_when_translocated() {
        assert_eq!(
            bundle_root_from_exe(Path::new(
                "/private/var/folders/ab/AppTranslocation/1234/d/Memlore.app/Contents/MacOS/Memlore"
            )),
            None
        );
    }

    // ── plan_targets ─────────────────────────────────────────────────────────

    #[test]
    fn plan_keeps_safe_present_targets_deduped_and_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let a = fake_home.join("Library").join(ID);
        let b = fake_home.join("Library").join("Caches").join(ID);
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let missing = fake_home.join("Library").join("Logs").join(ID);

        let plan = plan_targets(
            &[a.clone(), b.clone(), a.clone(), missing],
            &fake_home,
            &temp(),
            ID,
        );

        assert_eq!(plan.accepted, vec![a, b]);
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn plan_reports_existing_candidates_the_allow_list_refused() {
        // The XDG case: a real data dir that lives outside $HOME. It must never
        // be deleted, but the user has to be told it survives — otherwise the
        // dialog's "no copy is kept" promise is a lie.
        let tmp = tempfile::tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        let outside = tmp.path().join("data-volume").join(ID);
        std::fs::create_dir_all(&fake_home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let plan = plan_targets(&[outside.clone()], &fake_home, &temp(), ID);

        assert!(plan.accepted.is_empty(), "must never delete outside $HOME");
        assert_eq!(plan.skipped, vec![outside], "but must surface it");
    }

    #[test]
    fn plan_is_empty_when_nothing_qualifies_or_exists() {
        let plan = plan_targets(&[PathBuf::from("/nope/missing")], &home(), &temp(), ID);
        assert!(plan.accepted.is_empty());
        assert!(plan.skipped.is_empty(), "absent paths are not 'skipped'");
    }

    // ── reaper rendering ─────────────────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn unix_reaper_takes_targets_from_argv_not_from_source() {
        let script = render_reaper_unix(4242, "Fri Aug 29 10:00:00 2026");
        assert!(script.contains("PID=4242"));
        assert!(
            script.contains(r#"for t in "$@"; do rm -rf -- "$t"; done"#),
            "targets must arrive as argv and be quoted at use"
        );
        assert!(
            !script.contains("xargs"),
            "no temp list file, so no xargs handoff"
        );
        assert!(
            script.contains("LOG=$1") && script.contains("shift"),
            "log path is $1, targets follow"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reaper_pins_path_before_running_anything() {
        let script = render_reaper_unix(1, "");
        let first = script.lines().next().unwrap();
        assert_eq!(
            first, "PATH=/usr/bin:/bin",
            "PATH must be pinned on the very first line, before any command runs"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reaper_polls_with_an_integer_sleep() {
        let script = render_reaper_unix(1, "");
        assert!(
            script.contains("\n  sleep 1\n"),
            "fractional sleep is not POSIX; busybox would burn the whole wait instantly"
        );
        assert!(!script.contains("sleep 0."), "no fractional sleep anywhere");
    }

    #[cfg(unix)]
    #[test]
    fn unix_reaper_refuses_to_delete_when_the_app_never_exited() {
        let script = render_reaper_unix(1, "");
        assert!(
            script.contains(r#"if [ "$EXITED" -ne 1 ]; then"#),
            "timeout must be distinguished from a real exit"
        );
        let timeout_branch = script
            .split(r#"if [ "$EXITED" -ne 1 ]; then"#)
            .nth(1)
            .unwrap();
        let guard_body = timeout_branch.split("fi").next().unwrap();
        assert!(
            guard_body.contains("Nothing was deleted") && guard_body.contains("exit 1"),
            "on timeout the reaper must report and bail, never delete under a live app"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reaper_reports_survivors_to_the_failure_log() {
        let script = render_reaper_unix(1, "");
        assert!(
            script.contains("could not remove"),
            "a partial wipe must leave a findable record — the app is gone by then"
        );
        assert!(
            !script.contains("rm -rf -- \"$t\" 2>/dev/null"),
            "deletion errors must not be blanket-silenced"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_reaper_quotes_a_hostile_start_stamp() {
        let script = render_reaper_unix(7, "x'; rm -rf /; echo '");
        assert!(
            !script.contains("START='x'; rm"),
            "single quotes in the ps output must not break out of the assignment"
        );
        assert!(
            script.contains(r"'\''"),
            "quote must be escaped POSIX-style"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sh_quote_escapes_quotes_and_spaces() {
        assert_eq!(sh_quote("/a b/c"), "'/a b/c'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }

    #[cfg(windows)]
    #[test]
    fn windows_reaper_embeds_targets_and_avoids_reparse_traversal() {
        let script = render_reaper_windows(
            99,
            Some(12345),
            Path::new(r"C:\Users\t\memlore-uninstall-failed.log"),
            &[PathBuf::from(r"C:\Users\t\AppData\Roaming\app.memlore")],
        );
        assert!(script.contains(r"$targets = @('C:\Users\t\AppData\Roaming\app.memlore')"));
        assert!(
            !script.contains("Get-Content"),
            "newline-splitting list file is gone"
        );
        assert!(
            script.contains("[System.IO.Directory]::Delete($t, $true)"),
            "Remove-Item -Recurse follows junctions on PS 5.1"
        );
        assert!(
            script.contains("StartTime.Ticks -eq 12345"),
            "pid-reuse guard"
        );
        assert!(script.contains("could not remove"));
    }

    #[cfg(windows)]
    #[test]
    fn ps_quote_doubles_single_quotes() {
        assert_eq!(ps_quote(r"C:\a b"), r"'C:\a b'");
        assert_eq!(ps_quote("it's"), "'it''s'");
    }

    // ── path_size ────────────────────────────────────────────────────────────

    #[test]
    fn path_size_sums_files_recursively() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("nested")).unwrap();
        std::fs::write(tmp.path().join("a.bin"), vec![0u8; 1000]).unwrap();
        std::fs::write(tmp.path().join("nested").join("b.bin"), vec![0u8; 24]).unwrap();

        let size = path_size(tmp.path());
        assert!(
            size >= 1024,
            "must count both files (got {size}); directory entries add platform overhead"
        );
    }

    #[test]
    fn path_size_handles_a_deep_tree_without_overflowing_the_stack() {
        let tmp = tempfile::tempdir().unwrap();
        let mut deep = tmp.path().to_path_buf();
        for i in 0..2000 {
            deep = deep.join(format!("d{i}"));
        }
        // Very deep creation can fail on some filesystems (ENAMETOOLONG); the
        // point of the test is that path_size never recurses, so build what we
        // can and assert it returns.
        let _ = std::fs::create_dir_all(&deep);
        let size = path_size(tmp.path());
        assert!(size > 0, "iterative walk must return a size, not overflow");
    }

    #[test]
    fn path_size_of_a_missing_path_is_zero() {
        assert_eq!(path_size(Path::new("/nope/definitely/not/here")), 0);
    }

    // ── dir_is_writable ──────────────────────────────────────────────────────

    #[test]
    fn dir_is_writable_is_true_for_our_own_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(dir_is_writable(tmp.path()));
    }

    #[test]
    fn dir_is_writable_is_false_for_a_missing_directory() {
        assert!(!dir_is_writable(Path::new("/nope/definitely/not/here")));
    }

    #[cfg(unix)]
    #[test]
    fn dir_is_writable_is_false_without_the_write_bit() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        // Root ignores permission bits entirely; the assertion is meaningless there.
        if unsafe { libc::geteuid() } != 0 {
            assert!(
                !dir_is_writable(&locked),
                "r-xr-xr-x must not report as writable"
            );
        }
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
