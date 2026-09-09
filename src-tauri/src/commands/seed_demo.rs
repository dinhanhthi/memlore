//! Dev-only command: seed demo journals/entries/tags/media for local QA.
//!
//! **One-shot:** `seed_demo_data` applies the curated catalog once. Further
//! clicks are rejected; the UI disables the button via `seed_demo_status`.
//!
//! **Production hard gate (all layers must hold):**
//! 1. This module: `#[cfg(debug_assertions)]` in `commands/mod.rs` — not in release.
//! 2. Invoke handler: only registered under `cfg(debug_assertions)` in `lib.rs`.
//! 3. Seed library (`crate::seed`, including Wikipedia):
//!    `#[cfg(any(debug_assertions, test))]` — not linked into release binaries.
//! 4. Frontend: UI + `seedDemoData()` only under `import.meta.env.DEV`.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::seed::catalog::demo_entries;
use crate::seed::media_synth::fetch_picsum_jpeg;
use crate::seed::runner::{
    is_seed_demo_applied, peek_seed_generation, picsum_seed_for, run_seed_demo, SeedDemoResult,
    SeedOptions,
};
use crate::{AppState, EncryptionKeyState};

/// Status for the DEV Seed Demo button (applied once → button stays disabled).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedDemoStatus {
    /// True when demo journals already have live entries.
    pub applied: bool,
}

/// Pre-download all catalog inline photos outside the DB lock.
fn prefetch_picsum_cache(generation: u32) -> HashMap<u32, Vec<u8>> {
    let mut cache: HashMap<u32, Vec<u8>> = HashMap::new();
    for (entry_idx, entry) in demo_entries().iter().enumerate() {
        for photo_i in 0..entry.media.inline_photos {
            let seed = picsum_seed_for(entry_idx, photo_i, generation);
            if cache.contains_key(&seed) {
                continue;
            }
            match fetch_picsum_jpeg(seed, 800, 600) {
                Ok(bytes) => {
                    cache.insert(seed, bytes);
                }
                Err(e) => {
                    // Non-fatal: runner skips missing photos the same way.
                    eprintln!("seed_demo_data: picsum seed {seed} failed: {e}");
                }
            }
        }
    }
    cache
}

/// Core seed path (testable without AppHandle). Requires unlocked vault.
pub(crate) fn seed_demo_data_inner(
    state: &AppState,
    key_state: &EncryptionKeyState,
    media_dir: &std::path::Path,
) -> Result<SeedDemoResult, String> {
    // Prove unlocked before any network/DB work.
    key_state.with_key(|_key| Ok::<(), String>(()))?;

    std::fs::create_dir_all(media_dir).map_err(|e| e.to_string())?;

    // Fail fast (no Picsum download) when demo data is already present.
    {
        let conn = state.lock()?;
        if is_seed_demo_applied(&conn)? {
            return Err(
                "Demo data already seeded. Delete the [Demo] journals to seed again.".into(),
            );
        }
    }

    // First (and only) batch always uses generation 0 for Picsum seeds.
    let generation = {
        let conn = state.lock()?;
        peek_seed_generation(&conn)?
    };

    // Network I/O outside DB lock so other commands stay responsive.
    // Entry titles/bodies always come from the curated catalog (personal
    // journal stories, ~80% VI / ~20% EN). Wikipedia override is reserved
    // for tests / optional tooling — not the default seed path.
    let cache = prefetch_picsum_cache(generation);
    let fetch_image = Box::new(move |seed: u32| {
        cache
            .get(&seed)
            .cloned()
            .ok_or_else(|| "picsum unavailable offline".into())
    });

    let conn = state.lock()?;
    run_seed_demo(
        &conn,
        media_dir,
        SeedOptions {
            now_unix: None,
            fetch_image: Some(fetch_image),
            run_suffix: None,
            wiki_texts: None,
        },
    )
}

pub(crate) fn seed_demo_status_inner(
    state: &AppState,
    key_state: &EncryptionKeyState,
) -> Result<SeedDemoStatus, String> {
    key_state.with_key(|_key| Ok::<(), String>(()))?;
    let conn = state.lock()?;
    Ok(SeedDemoStatus {
        applied: is_seed_demo_applied(&conn)?,
    })
}

/// Insert demo journals/entries/tags/media via production create paths.
///
/// **One-shot:** fails if demo journals already have entries. Curated catalog
/// only (multi-paragraph journal stories). Does **not** call `sync_now` —
/// leaves sync_state / media upload pending. Debug builds only.
///
/// **Why `async fn` + `spawn_blocking`?** Prefetch uses `reqwest::blocking`
/// (Picsum) and seeding holds the DB mutex across many transactions.
/// Running that on the async executor stalls IPC/UI. Mirror `sync_now`:
/// resolve `State` inside the blocking pool via `AppHandle`.
#[tauri::command]
pub async fn seed_demo_data(app: AppHandle) -> Result<SeedDemoResult, String> {
    let media_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");

    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        seed_demo_data_inner(&state, &key_state, &media_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether curated demo data is already present (button should stay disabled).
#[tauri::command]
pub async fn seed_demo_status(app: AppHandle) -> Result<SeedDemoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let key_state = app.state::<EncryptionKeyState>();
        seed_demo_status_inner(&state, &key_state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use rusqlite::Connection;

    #[test]
    fn seed_demo_data_requires_unlocked_key() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let state = AppState::new(conn);
        let key_state = EncryptionKeyState::new();
        let dir = tempfile::tempdir().unwrap();

        let err = seed_demo_data_inner(&state, &key_state, dir.path()).unwrap_err();
        assert!(
            err.contains("locked") || err.contains("not initialized"),
            "expected locked error, got: {err}"
        );
    }

    #[test]
    fn picsum_seed_formula_matches_runner() {
        assert_eq!(picsum_seed_for(0, 0, 0), 1);
        assert_eq!(picsum_seed_for(1, 0, 0), 32);
        assert_eq!(picsum_seed_for(2, 1, 0), 64);
        assert_eq!(picsum_seed_for(0, 0, 1), 10_001);
    }
}
