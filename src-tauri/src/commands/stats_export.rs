//! Statistics export — universal byte sink for files chosen via the
//! native save dialog on the frontend.
//!
//! The frontend builds the entire payload (CSV / JSON / HTML / PNG zip
//! / PDF) and hands the resulting bytes plus the user-selected path to
//! this command. Keeping the writer here means we don't need to ship
//! `tauri-plugin-fs` or widen frontend filesystem permissions just to
//! drop a file the user explicitly picked.

use std::fs;
use std::path::Path;

/// Write the supplied bytes to `path`, creating parent directories
/// as needed.
///
/// Errors are surfaced as plain `String`s so the frontend can render
/// them inline in the export modal. The command refuses an empty path
/// (defensive — the Tauri dialog should never return one, but a
/// programmer mistake should not silently produce a file at `cwd`).
#[tauri::command]
pub fn export_stats_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Export path is empty".to_string());
    }

    let p = Path::new(trimmed);

    // Create parent directories if missing. The Tauri save dialog
    // always returns a full path inside an existing directory, but a
    // user pasting a custom path through future UI affordances might
    // not — and `fs::write` would fail with a confusing "No such file
    // or directory" otherwise.
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
        }
    }

    fs::write(p, &bytes).map_err(|e| format!("Failed to write {}: {e}", p.display()))?;
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Small helper — write a payload to a temp path and read it back.
    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        // Namespace under a per-process subdir to avoid collisions
        // when several tests run in parallel and pick the same name.
        p.push(format!("memlore-stats-export-{}", std::process::id()));
        p.push(name);
        p
    }

    #[test]
    fn writes_simple_payload() {
        let dest = tmp_path("simple.txt");
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(dest.parent().unwrap());

        let payload = b"hello stats".to_vec();
        export_stats_file(dest.to_string_lossy().into_owned(), payload.clone())
            .expect("write should succeed");

        let read = fs::read(&dest).expect("file should exist");
        assert_eq!(read, payload);
    }

    #[test]
    fn writes_binary_payload() {
        let dest = tmp_path("binary.bin");
        let _ = fs::remove_file(&dest);

        // Bytes that are NOT valid UTF-8 — proves we're not accidentally
        // coercing the body through a String somewhere.
        let payload: Vec<u8> = vec![0x00, 0xFF, 0xFE, 0xC0, 0xC1];
        export_stats_file(dest.to_string_lossy().into_owned(), payload.clone())
            .expect("write should succeed");

        let read = fs::read(&dest).expect("file should exist");
        assert_eq!(read, payload);
    }

    #[test]
    fn rejects_empty_path() {
        let err = export_stats_file(String::new(), b"x".to_vec()).unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[test]
    fn rejects_whitespace_path() {
        let err = export_stats_file("   ".to_string(), b"x".to_vec()).unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[test]
    fn creates_missing_parent_directories() {
        let mut dest = tmp_path("nested");
        dest.push("a");
        dest.push("b");
        dest.push("c.txt");
        let _ = fs::remove_dir_all(dest.parent().unwrap().parent().unwrap().parent().unwrap());

        export_stats_file(dest.to_string_lossy().into_owned(), b"deep".to_vec())
            .expect("write should succeed even with missing parents");

        assert!(dest.exists());
        assert_eq!(fs::read(&dest).unwrap(), b"deep");
    }

    #[test]
    fn overwrites_existing_file() {
        let dest = tmp_path("overwrite.txt");
        export_stats_file(dest.to_string_lossy().into_owned(), b"first".to_vec()).unwrap();
        export_stats_file(dest.to_string_lossy().into_owned(), b"second".to_vec()).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"second");
    }
}
