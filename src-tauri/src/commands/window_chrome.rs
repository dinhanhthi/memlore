//! Titlebar row height → native macOS traffic-light placement.
//!
//! Tauri 2 has no runtime setter for `trafficLightPosition`, and tao re-applies
//! the config value on every `drawRect`, so the key is deliberately absent from
//! `tauri.conf.json` and this module owns the placement: the frontend reports
//! its titlebar row height (Clay is taller), we centre the native cluster in
//! it, and re-apply after AppKit rebuilds the titlebar (resize, fullscreen
//! exit, appearance or scale-factor change).

use std::path::Path;
use std::sync::Mutex;

/// Signature/Clean row height — keep paired with `titlebarRowHeight()` in
/// `src/lib/windowChrome.ts`.
const DEFAULT_TITLEBAR_ROW_HEIGHT: f64 = 36.0;

/// Persisted-format change: new one-line file `{app_data}/titlebar_row_height`.
/// Missing or invalid → default 36. No migration shim (dev-only; wipe is fine).
const TITLEBAR_ROW_HEIGHT_FILE: &str = "titlebar_row_height";

/// Last row height reported by the frontend (logical px).
pub struct TitlebarRowHeight(pub Mutex<f64>);

impl Default for TitlebarRowHeight {
    fn default() -> Self {
        Self(Mutex::new(DEFAULT_TITLEBAR_ROW_HEIGHT))
    }
}

impl TitlebarRowHeight {
    /// Seed from `{dir}/titlebar_row_height` before the first `apply`.
    /// `None` or an unreadable/invalid file → default 36.
    pub fn from_persisted(dir: Option<&Path>) -> Self {
        Self(Mutex::new(
            dir.map(load_persisted_row_height)
                .unwrap_or(DEFAULT_TITLEBAR_ROW_HEIGHT),
        ))
    }
}

/// Reject NaN/∞ and anything outside a sane titlebar range.
fn validate_row_height(height: f64) -> Result<f64, String> {
    if height.is_finite() && (20.0..=120.0).contains(&height) {
        Ok(height)
    } else {
        Err(format!("invalid titlebar row height: {height}"))
    }
}

/// `(x, y)` inset for tao-style `inset_traffic_lights` math given a titlebar
/// row of `height` logical px. Measured on macOS 26: the 14px button frame
/// centre lands at inset `y - 2`, so `y = height / 2 + 2` puts the centre on
/// `height / 2` (36 → inset 20 → centre 18; 44 → inset 24 → centre 22). The
/// former config `y = 18` sat 2px high. `x = 16` pairs with the `pl-22.5`
/// tab-strip clearance in `TitleBar.tsx`.
fn inset_for_row_height(height: f64) -> (f64, f64) {
    (16.0, height / 2.0 + 2.0)
}

/// Read `{dir}/titlebar_row_height`. Missing or invalid (parse / range) → 36.
fn load_persisted_row_height(dir: &Path) -> f64 {
    let Ok(text) = std::fs::read_to_string(dir.join(TITLEBAR_ROW_HEIGHT_FILE)) else {
        return DEFAULT_TITLEBAR_ROW_HEIGHT;
    };
    let Ok(parsed) = text.trim().parse::<f64>() else {
        return DEFAULT_TITLEBAR_ROW_HEIGHT;
    };
    validate_row_height(parsed).unwrap_or(DEFAULT_TITLEBAR_ROW_HEIGHT)
}

fn save_persisted_row_height(dir: &Path, height: f64) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(TITLEBAR_ROW_HEIGHT_FILE), format!("{height}\n"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_titlebar_row_height(
    window: tauri::Window,
    state: tauri::State<'_, TitlebarRowHeight>,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    let height = validate_row_height(height)?;
    *state.0.lock().map_err(|e| e.to_string())? = height;
    if let Ok(dir) = window.path().app_data_dir() {
        if let Err(e) = save_persisted_row_height(&dir, height) {
            log::warn!("failed to persist titlebar row height: {e}");
        }
    }
    apply(&window)
}

/// Re-apply the stored row height to `window`'s traffic lights. Queued onto
/// the main thread so a call from a `Resized` handler lands after AppKit's
/// own titlebar layout for that frame.
pub fn apply(window: &tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let height = *window
            .state::<TitlebarRowHeight>()
            .0
            .lock()
            .map_err(|e| e.to_string())?;
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                // Resolve the NSWindow at execution time — the window may have
                // been closed between queueing and running.
                if let Ok(ns_window) = win.ns_window() {
                    unsafe { macos::inset(ns_window, inset_for_row_height(height)) }
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    /// Port of tao's `inset_traffic_lights` (`platform_impl/macos/view.rs`):
    /// grow the titlebar container to `button_height + y`, pin it to the top
    /// edge, and slide the three buttons to `x + i * spacing`.
    ///
    /// # Safety
    /// `ns_window` must be a live `NSWindow*` and this must run on the main
    /// thread.
    pub unsafe fn inset(ns_window: *mut std::ffi::c_void, (x, y): (f64, f64)) {
        let window: &NSWindow = &*ns_window.cast::<NSWindow>();
        let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let Some(mini) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
            return;
        };
        let Some(zoom) = window.standardWindowButton(NSWindowButton::ZoomButton) else {
            return;
        };
        let Some(container) = close.superview().and_then(|v| v.superview()) else {
            return;
        };

        let close_frame = close.frame();
        let titlebar_height = close_frame.size.height + y;
        let mut container_frame = container.frame();
        container_frame.size.height = titlebar_height;
        container_frame.origin.y = window.frame().size.height - titlebar_height;
        container.setFrame(container_frame);

        let spacing = mini.frame().origin.x - close_frame.origin.x;
        for (i, button) in [&close, &mini, &zoom].into_iter().enumerate() {
            let mut origin = button.frame().origin;
            origin.x = x + i as f64 * spacing;
            button.setFrameOrigin(origin);
        }

        // Where the cluster actually landed, measured from the window's top
        // edge — the number to compare against `row_height / 2`.
        if log::log_enabled!(log::Level::Debug) {
            let in_window = close.convertRect_toView(close.bounds(), None);
            let top = window.frame().size.height - in_window.origin.y - in_window.size.height;
            log::debug!(
                "traffic lights: inset y={y} → close button top={top:.1} h={:.1} centre={:.1}",
                in_window.size.height,
                top + in_window.size.height / 2.0
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_row_inset_is_20() {
        assert_eq!(
            inset_for_row_height(DEFAULT_TITLEBAR_ROW_HEIGHT),
            (16.0, 20.0)
        );
    }

    #[test]
    fn taller_row_moves_cluster_down_linearly() {
        assert_eq!(inset_for_row_height(44.0), (16.0, 24.0));
    }

    #[test]
    fn validate_accepts_range_bounds() {
        assert_eq!(validate_row_height(20.0), Ok(20.0));
        assert_eq!(validate_row_height(36.0), Ok(36.0));
        assert_eq!(validate_row_height(120.0), Ok(120.0));
    }

    #[test]
    fn validate_rejects_out_of_range_and_non_finite() {
        for bad in [
            19.9,
            120.1,
            -36.0,
            0.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert!(
                validate_row_height(bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn persist_write_then_read_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        save_persisted_row_height(tmp.path(), 44.0).unwrap();
        assert_eq!(load_persisted_row_height(tmp.path()), 44.0);
    }

    #[test]
    fn persist_write_is_one_line() {
        let tmp = tempfile::tempdir().unwrap();
        save_persisted_row_height(tmp.path(), 44.0).unwrap();
        let text = std::fs::read_to_string(tmp.path().join(TITLEBAR_ROW_HEIGHT_FILE)).unwrap();
        assert_eq!(text, "44\n");
    }

    #[test]
    fn persist_read_missing_file_is_default() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            load_persisted_row_height(tmp.path()),
            DEFAULT_TITLEBAR_ROW_HEIGHT
        );
    }

    #[test]
    fn persist_read_invalid_file_is_default() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["not-a-number\n", "19.9\n", "999\n", "NaN\n", ""] {
            std::fs::write(tmp.path().join(TITLEBAR_ROW_HEIGHT_FILE), bad).unwrap();
            assert_eq!(
                load_persisted_row_height(tmp.path()),
                DEFAULT_TITLEBAR_ROW_HEIGHT,
                "{bad:?} should fall back to default"
            );
        }
    }
}
