use tauri::State;

use crate::db;
use crate::utils::geocoding::{self, GeocodeProvider, GeocodeSuggestion};
use crate::AppState;

// ─── Settings helper ──────────────────────────────────────────────────────────

/// Read the geocoding provider and the matching API key from the settings table.
///
/// Returns `(provider, api_key)` where `api_key` is `None` for Photon/Nominatim
/// (no key needed) or the stored key for Mapbox/MapTiler/Google.
///
/// Returns `Err("missing_api_key")` if a paid provider is configured but the
/// corresponding key is absent or whitespace-only.
pub fn read_provider_settings(
    conn: &rusqlite::Connection,
) -> Result<(GeocodeProvider, Option<String>), String> {
    let provider_str = db::get_setting(conn, "geocoding_provider")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    let provider = GeocodeProvider::from_setting(&provider_str);

    let api_key = match provider {
        GeocodeProvider::Nominatim | GeocodeProvider::Photon => None,
        GeocodeProvider::Mapbox => {
            let key = db::get_setting(conn, "mapbox_api_key")
                .map_err(|e| e.to_string())?
                .filter(|s| !s.trim().is_empty());
            match key {
                Some(k) => Some(k),
                None => return Err("missing_api_key".into()),
            }
        }
        GeocodeProvider::MapTiler => {
            let key = db::get_setting(conn, "maptiler_api_key")
                .map_err(|e| e.to_string())?
                .filter(|s| !s.trim().is_empty());
            match key {
                Some(k) => Some(k),
                None => return Err("missing_api_key".into()),
            }
        }
        GeocodeProvider::GooglePlaces => {
            let key = db::get_setting(conn, "google_api_key")
                .map_err(|e| e.to_string())?
                .filter(|s| !s.trim().is_empty());
            match key {
                Some(k) => Some(k),
                None => return Err("missing_api_key".into()),
            }
        }
    };

    Ok((provider, api_key))
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Search for geocoding suggestions for the given query string.
///
/// Provider and API key are read from the settings table:
/// - `geocoding_provider` → `"nominatim"` | `"photon"` | `"mapbox"` | `"maptiler"` | `"google"` (default: Photon)
/// - `mapbox_api_key` / `maptiler_api_key` / `google_api_key` — required when the matching provider is active.
///
/// Returns `Err("missing_api_key")` when a paid provider is active but no key
/// is configured.
#[tauri::command]
pub async fn geocode_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
    session_token: Option<String>,
) -> Result<Vec<GeocodeSuggestion>, String> {
    let (provider, api_key) = {
        let conn = state.lock()?;
        read_provider_settings(&conn)?
    };

    let effective_limit = limit.unwrap_or(5);
    geocoding::search(
        provider,
        &query,
        api_key.as_deref(),
        effective_limit,
        session_token.as_deref(),
    )
    .await
}

/// Reverse-geocode a coordinate pair into a readable label using the
/// configured geocoding provider. Returns `None` when the provider yields
/// no match (e.g. open ocean) or when the configured provider is Google
/// Places (which requires a separate billable reverse endpoint we have not
/// wired up). The caller renders a graceful fallback (raw coordinates).
///
/// Returns `Err("missing_api_key")` when a paid provider is active but no
/// API key is configured — mirrors `geocode_search`.
#[tauri::command]
pub async fn geocode_reverse(
    state: State<'_, AppState>,
    latitude: f64,
    longitude: f64,
) -> Result<Option<GeocodeSuggestion>, String> {
    let (provider, api_key) = {
        let conn = state.lock()?;
        read_provider_settings(&conn)?
    };

    geocoding::reverse(provider, latitude, longitude, api_key.as_deref()).await
}

/// Resolve a place ID to full coordinates. Only meaningful for Google Places —
/// Nominatim and Mapbox already include coordinates in the search results.
///
/// Returns `Err("resolve_place not needed for this provider")` for
/// Nominatim/Mapbox so the caller can short-circuit.
#[tauri::command]
pub async fn geocode_resolve(
    state: State<'_, AppState>,
    place_id: String,
    session_token: Option<String>,
) -> Result<GeocodeSuggestion, String> {
    let (provider, api_key) = {
        let conn = state.lock()?;
        read_provider_settings(&conn)?
    };

    geocoding::resolve_place(
        provider,
        &place_id,
        api_key.as_deref(),
        session_token.as_deref(),
    )
    .await
}

/// Probe a geocoding provider with a fixed test query. The provider and key
/// come from arguments — not from the settings table — so the Settings panel
/// can validate a key the user has just typed but not yet saved.
///
/// `provider` matches the same string values as the `geocoding_provider`
/// setting (`"nominatim"`, `"photon"`, `"mapbox"`, `"maptiler"`, `"google"`). Unknown values
/// fall back to Photon, mirroring `GeocodeProvider::from_setting`.
///
/// Returns one of the stable error codes documented on `geocoding::check`
/// (`missing_api_key`, `invalid_key`, `rate_limited`, `network_error`,
/// `server_error`, `invalid_response`).
#[tauri::command]
pub async fn geocode_check(provider: String, api_key: Option<String>) -> Result<(), String> {
    let provider = GeocodeProvider::from_setting(&provider);
    // `geocoding::check` normalizes the key internally (trims, treats empty
    // as missing) — no need to pre-process here.
    geocoding::check(provider, api_key.as_deref()).await
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, schema::migrate};
    use rusqlite::Connection;

    fn make_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    // ── read_provider_settings ───────────────────────────────────────────────

    #[test]
    fn read_provider_settings_defaults_to_photon_no_key() {
        let conn = make_conn();
        // No settings set → defaults to Photon, key is None
        let (provider, key) = read_provider_settings(&conn).expect("should succeed");
        assert_eq!(provider, GeocodeProvider::Photon);
        assert!(key.is_none());
    }

    #[test]
    fn read_provider_settings_returns_mapbox_with_key_when_set() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "mapbox").unwrap();
        db::set_setting(&conn, "mapbox_api_key", "pk.my_mapbox_key").unwrap();

        let (provider, key) = read_provider_settings(&conn).expect("should succeed");
        assert_eq!(provider, GeocodeProvider::Mapbox);
        assert_eq!(key.as_deref(), Some("pk.my_mapbox_key"));
    }

    #[test]
    fn read_provider_settings_returns_error_when_paid_provider_missing_key() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "mapbox").unwrap();
        // No mapbox_api_key set → error

        let result = read_provider_settings(&conn);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[test]
    fn read_provider_settings_treats_whitespace_only_key_as_missing() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "google").unwrap();
        db::set_setting(&conn, "google_api_key", "   ").unwrap();

        let result = read_provider_settings(&conn);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[test]
    fn read_provider_settings_google_with_valid_key() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "google").unwrap();
        db::set_setting(&conn, "google_api_key", "AIzaSy_test_key").unwrap();

        let (provider, key) = read_provider_settings(&conn).expect("should succeed");
        assert_eq!(provider, GeocodeProvider::GooglePlaces);
        assert_eq!(key.as_deref(), Some("AIzaSy_test_key"));
    }

    #[test]
    fn read_provider_settings_photon_no_key_needed() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "photon").unwrap();

        let (provider, key) = read_provider_settings(&conn).expect("should succeed");
        assert_eq!(provider, GeocodeProvider::Photon);
        assert!(key.is_none());
    }

    #[test]
    fn read_provider_settings_nominatim_ignores_any_api_keys() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "nominatim").unwrap();
        // Even if keys happen to be set, Nominatim doesn't use them
        db::set_setting(&conn, "mapbox_api_key", "some_key").unwrap();

        let (provider, key) = read_provider_settings(&conn).expect("should succeed");
        assert_eq!(provider, GeocodeProvider::Nominatim);
        assert!(key.is_none());
    }

    #[test]
    fn read_provider_settings_returns_maptiler_with_key_when_set() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "maptiler").unwrap();
        db::set_setting(&conn, "maptiler_api_key", "mt_live").unwrap();

        let (provider, key) = read_provider_settings(&conn).expect("should succeed");
        assert_eq!(provider, GeocodeProvider::MapTiler);
        assert_eq!(key.as_deref(), Some("mt_live"));
    }

    #[test]
    fn read_provider_settings_maptiler_missing_key_is_error() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "maptiler").unwrap();

        let result = read_provider_settings(&conn);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[test]
    fn read_provider_settings_empty_mapbox_key_is_missing() {
        let conn = make_conn();
        db::set_setting(&conn, "geocoding_provider", "mapbox").unwrap();
        db::set_setting(&conn, "mapbox_api_key", "").unwrap();

        let result = read_provider_settings(&conn);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    // ── geocode_check ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn geocode_check_missing_key_for_mapbox() {
        let result = geocode_check("mapbox".into(), None).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn geocode_check_missing_key_for_maptiler() {
        let result = geocode_check("maptiler".into(), None).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn geocode_check_treats_whitespace_key_as_missing() {
        let result = geocode_check("google".into(), Some("   ".into())).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn geocode_check_unknown_provider_falls_back_to_photon() {
        // Doesn't require a key — confirms the unknown-provider fallback path.
        // We don't assert success/failure on the network call itself (CI may be
        // offline). We only assert it does NOT short-circuit with missing_api_key.
        let result = geocode_check("does-not-exist".into(), None).await;
        if let Err(e) = result {
            assert_ne!(e, "missing_api_key");
        }
    }
}
