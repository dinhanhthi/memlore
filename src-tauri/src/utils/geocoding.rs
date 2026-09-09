use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// `redact_secret` lives in `crate::utils::secrets` so the AI-provider HTTP
// layer (Phase 6 v2 R2) shares the same regex-free scrubber. Behaviour
// unchanged from the previously-inlined helper.
use crate::utils::secrets::redact_secret;

fn user_agent() -> String {
    format!(
        "Memlore/{} (https://github.com/dinhanhthi/memlore)",
        env!("CARGO_PKG_VERSION")
    )
}

/// Process-wide Nominatim rate gate. OSM's usage policy requires ≥1 request
/// per second; Photon / Mapbox / Google are not throttled here.
static NOMINATIM_GATE: Mutex<Option<Instant>> = Mutex::new(None);

const NOMINATIM_MIN_INTERVAL: Duration = Duration::from_secs(1);

/// How long to sleep before the next Nominatim HTTP call so consecutive
/// requests are spaced by at least [`NOMINATIM_MIN_INTERVAL`]. Pure so the
/// spacing table is unit-tested without sleeping.
fn nominatim_wait(last: Option<Instant>, now: Instant) -> Duration {
    match last {
        None => Duration::ZERO,
        // `prev` is the reserved fire Instant; the next fire is prev + 1s.
        // When `prev` is in the future (a slot another concurrent caller
        // already reserved), this correctly spaces off that slot instead of
        // collapsing to 1s from `now`.
        Some(prev) => (prev + NOMINATIM_MIN_INTERVAL).saturating_duration_since(now),
    }
}

async fn nominatim_throttle() {
    let sleep_for = {
        let mut gate = NOMINATIM_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let wait = nominatim_wait(*gate, now);
        // Reserve this slot so a concurrent caller spaces off the *fire*
        // time, not the lock-acquire time.
        *gate = Some(now + wait);
        wait
    };
    if !sleep_for.is_zero() {
        tokio::time::sleep(sleep_for).await;
    }
}

// ─── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeocodeSuggestion {
    pub place_id: String,
    pub label: String,
    pub address: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeocodeProvider {
    Nominatim,
    Photon,
    Mapbox,
    MapTiler,
    GooglePlaces,
}

impl GeocodeProvider {
    /// Parse from the settings table value. Defaults to Photon for unknown
    /// or empty values. Nominatim is opt-in via the explicit `"nominatim"`
    /// setting (and is throttled to ≥1 req/s).
    pub fn from_setting(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "nominatim" => GeocodeProvider::Nominatim,
            "photon" => GeocodeProvider::Photon,
            "mapbox" => GeocodeProvider::Mapbox,
            "maptiler" => GeocodeProvider::MapTiler,
            "google" => GeocodeProvider::GooglePlaces,
            _ => GeocodeProvider::Photon,
        }
    }
}

// ─── Parse helpers (pure — no I/O, so we can test them directly) ─────────────

/// Parse the Nominatim JSON search response into suggestions.
pub fn parse_nominatim_response(json: &str) -> Result<Vec<GeocodeSuggestion>, String> {
    #[derive(Debug, Deserialize)]
    struct NominatimItem {
        place_id: serde_json::Value,
        display_name: String,
        lat: String,
        lon: String,
        name: Option<String>,
    }

    let items: Vec<NominatimItem> =
        serde_json::from_str(json).map_err(|e| format!("Nominatim parse error: {e}"))?;

    let suggestions = items
        .into_iter()
        .map(|item| {
            let place_id = match &item.place_id {
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let label = item.name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
                item.display_name
                    .split(',')
                    .next()
                    .unwrap_or(&item.display_name)
                    .trim()
                    .to_string()
            });
            let latitude = item
                .lat
                .parse::<f64>()
                .map_err(|e| format!("Nominatim lat parse error: {e}"))?;
            let longitude = item
                .lon
                .parse::<f64>()
                .map_err(|e| format!("Nominatim lon parse error: {e}"))?;
            Ok(GeocodeSuggestion {
                place_id,
                label,
                address: item.display_name,
                latitude,
                longitude,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(suggestions)
}

/// Parse the Photon (Komoot) GeoJSON search response into suggestions.
/// Response shape: `{"features": [{"geometry": {"coordinates": [lng, lat]}, "properties": {...}}]}`
pub fn parse_photon_response(json: &str) -> Result<Vec<GeocodeSuggestion>, String> {
    #[derive(Debug, Deserialize)]
    struct PhotonGeometry {
        coordinates: [f64; 2],
    }
    #[derive(Debug, Deserialize)]
    struct PhotonProperties {
        #[serde(rename = "osm_id")]
        osm_id: Option<serde_json::Value>,
        name: Option<String>,
        city: Option<String>,
        country: Option<String>,
        street: Option<String>,
        housenumber: Option<String>,
        postcode: Option<String>,
        state: Option<String>,
    }
    #[derive(Debug, Deserialize)]
    struct PhotonFeature {
        geometry: PhotonGeometry,
        properties: PhotonProperties,
    }
    #[derive(Debug, Deserialize)]
    struct PhotonResponse {
        features: Vec<PhotonFeature>,
    }

    let resp: PhotonResponse =
        serde_json::from_str(json).map_err(|e| format!("Photon parse error: {e}"))?;

    let suggestions = resp
        .features
        .into_iter()
        .enumerate()
        .map(|(idx, f)| {
            let p = f.properties;
            let label = p.name.clone().unwrap_or_else(|| {
                // Fall back to city, then country
                p.city
                    .clone()
                    .or_else(|| p.country.clone())
                    .unwrap_or_else(|| format!("Place {}", idx + 1))
            });

            // Build a human-readable address from available parts
            let address_parts: Vec<String> = [
                p.name.as_deref(),
                p.housenumber.as_deref(),
                p.street.as_deref(),
                p.postcode.as_deref(),
                p.city.as_deref(),
                p.state.as_deref(),
                p.country.as_deref(),
            ]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();

            let address = if address_parts.is_empty() {
                label.clone()
            } else {
                address_parts.join(", ")
            };

            let place_id = match &p.osm_id {
                Some(serde_json::Value::Number(n)) => format!("photon:{n}"),
                Some(serde_json::Value::String(s)) => format!("photon:{s}"),
                _ => format!("photon:{idx}"),
            };

            GeocodeSuggestion {
                place_id,
                label,
                address,
                // Photon GeoJSON: coordinates = [longitude, latitude]
                longitude: f.geometry.coordinates[0],
                latitude: f.geometry.coordinates[1],
            }
        })
        .collect();

    Ok(suggestions)
}

/// Parse Mapbox / MapTiler GeoJSON geocoding features (`center` is [lng, lat]).
fn parse_geojson_place_features(
    json: &str,
    source: &str,
) -> Result<Vec<GeocodeSuggestion>, String> {
    #[derive(Debug, Deserialize)]
    struct GeoJsonFeature {
        id: String,
        text: String,
        place_name: String,
        center: [f64; 2],
    }
    #[derive(Debug, Deserialize)]
    struct GeoJsonResponse {
        features: Vec<GeoJsonFeature>,
    }

    let resp: GeoJsonResponse =
        serde_json::from_str(json).map_err(|e| format!("{source} parse error: {e}"))?;

    let suggestions = resp
        .features
        .into_iter()
        .map(|f| GeocodeSuggestion {
            place_id: f.id,
            label: f.text,
            address: f.place_name,
            longitude: f.center[0],
            latitude: f.center[1],
        })
        .collect();

    Ok(suggestions)
}

/// Parse the Mapbox Geocoding API JSON response into suggestions.
pub fn parse_mapbox_response(json: &str) -> Result<Vec<GeocodeSuggestion>, String> {
    parse_geojson_place_features(json, "Mapbox")
}

/// Parse the MapTiler Geocoding API JSON response into suggestions.
/// Same GeoJSON shape as Mapbox (`id`, `text`, `place_name`, `center`).
pub fn parse_maptiler_response(json: &str) -> Result<Vec<GeocodeSuggestion>, String> {
    parse_geojson_place_features(json, "MapTiler")
}

/// Parse the Google Places Autocomplete JSON response into suggestions.
/// Lat/lng are 0.0 placeholders — resolved on selection via `resolve_place`.
pub fn parse_google_autocomplete_response(json: &str) -> Result<Vec<GeocodeSuggestion>, String> {
    #[derive(Debug, Deserialize)]
    struct Prediction {
        place_id: String,
        description: String,
        #[serde(default)]
        structured_formatting: Option<StructuredFormatting>,
    }
    #[derive(Debug, Deserialize)]
    struct StructuredFormatting {
        main_text: String,
    }
    #[derive(Debug, Deserialize)]
    struct AutocompleteResponse {
        predictions: Vec<Prediction>,
    }

    let resp: AutocompleteResponse =
        serde_json::from_str(json).map_err(|e| format!("Google autocomplete parse error: {e}"))?;

    let suggestions = resp
        .predictions
        .into_iter()
        .map(|p| {
            let label = p
                .structured_formatting
                .map(|sf| sf.main_text)
                .unwrap_or_else(|| {
                    p.description
                        .split(',')
                        .next()
                        .unwrap_or(&p.description)
                        .trim()
                        .to_string()
                });
            GeocodeSuggestion {
                place_id: p.place_id,
                label,
                address: p.description,
                latitude: 0.0,
                longitude: 0.0,
            }
        })
        .collect();

    Ok(suggestions)
}

/// Parse the Google Place Details JSON response into a single suggestion.
pub fn parse_google_place_details_response(json: &str) -> Result<GeocodeSuggestion, String> {
    #[derive(Debug, Deserialize)]
    struct PlaceDetailsResponse {
        result: PlaceResult,
    }
    #[derive(Debug, Deserialize)]
    struct PlaceResult {
        place_id: Option<String>,
        name: Option<String>,
        formatted_address: Option<String>,
        geometry: Geometry,
    }
    #[derive(Debug, Deserialize)]
    struct Geometry {
        location: LatLng,
    }
    #[derive(Debug, Deserialize)]
    struct LatLng {
        lat: f64,
        lng: f64,
    }

    let resp: PlaceDetailsResponse =
        serde_json::from_str(json).map_err(|e| format!("Google place details parse error: {e}"))?;

    let r = resp.result;
    let label = r.name.unwrap_or_else(|| "Unknown".to_string());
    let address = r.formatted_address.unwrap_or_else(|| label.clone());

    Ok(GeocodeSuggestion {
        place_id: r.place_id.unwrap_or_default(),
        label,
        address,
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
    })
}

// ─── Async HTTP functions ─────────────────────────────────────────────────────

/// Search for geocoding suggestions.
///
/// Empty or whitespace-only queries immediately return `Ok(vec![])` without any
/// HTTP call.
pub async fn search(
    provider: GeocodeProvider,
    query: &str,
    api_key: Option<&str>,
    limit: u32,
    session_token: Option<&str>,
) -> Result<Vec<GeocodeSuggestion>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    match provider {
        GeocodeProvider::Nominatim => nominatim_search(query, limit).await,
        GeocodeProvider::Photon => photon_search(query, limit).await,
        GeocodeProvider::Mapbox => {
            let key = api_key.ok_or("missing_api_key")?;
            mapbox_search(query, key, limit).await
        }
        GeocodeProvider::MapTiler => {
            let key = api_key.ok_or("missing_api_key")?;
            maptiler_search(query, key, limit).await
        }
        GeocodeProvider::GooglePlaces => {
            let key = api_key.ok_or("missing_api_key")?;
            google_autocomplete_search(query, key, session_token).await
        }
    }
}

/// Reverse-geocode a coordinate pair into a human-readable label.
///
/// Returns `Some(suggestion)` when the provider yields a result. Returns
/// `None` for the "no match in the gazetteer" case (e.g. open ocean) so
/// the caller can render a graceful fallback (lat/lng string) without
/// flagging an error.
pub async fn reverse(
    provider: GeocodeProvider,
    latitude: f64,
    longitude: f64,
    api_key: Option<&str>,
) -> Result<Option<GeocodeSuggestion>, String> {
    if !latitude.is_finite() || !longitude.is_finite() {
        return Err("invalid_coordinates".into());
    }
    match provider {
        GeocodeProvider::Nominatim => nominatim_reverse(latitude, longitude).await,
        GeocodeProvider::Photon => photon_reverse(latitude, longitude).await,
        GeocodeProvider::Mapbox => {
            let key = api_key.ok_or("missing_api_key")?;
            mapbox_reverse(latitude, longitude, key).await
        }
        GeocodeProvider::MapTiler => {
            let key = api_key.ok_or("missing_api_key")?;
            maptiler_reverse(latitude, longitude, key).await
        }
        GeocodeProvider::GooglePlaces => {
            let key = api_key.ok_or("missing_api_key")?;
            google_reverse(latitude, longitude, key).await
        }
    }
}

/// Resolve a place to full coordinates. Only needed for Google Places — Nominatim,
/// Photon, and Mapbox already return coordinates in the search results.
pub async fn resolve_place(
    provider: GeocodeProvider,
    place_id: &str,
    api_key: Option<&str>,
    session_token: Option<&str>,
) -> Result<GeocodeSuggestion, String> {
    match provider {
        GeocodeProvider::Nominatim
        | GeocodeProvider::Photon
        | GeocodeProvider::Mapbox
        | GeocodeProvider::MapTiler => Err("resolve_place not needed for this provider".into()),
        GeocodeProvider::GooglePlaces => {
            let key = api_key.ok_or("missing_api_key")?;
            google_place_details(place_id, key, session_token).await
        }
    }
}

/// Probe a provider with a fixed test query to verify it's reachable and the
/// API key (if any) is accepted. Returns a stable error-code string on failure
/// so the frontend can show a localized message:
///
/// - `missing_api_key` — provider requires a key but none was passed.
/// - `invalid_key` — provider rejected the key (HTTP 401/403 or status="REQUEST_DENIED").
/// - `rate_limited` — HTTP 429.
/// - `network_error` — DNS / TCP / TLS / timeout.
/// - `server_error` — non-2xx HTTP status not classified above.
/// - `invalid_response` — 2xx but body couldn't be parsed.
pub async fn check(provider: GeocodeProvider, api_key: Option<&str>) -> Result<(), String> {
    // Fixed query that geocodes well across every provider.
    const TEST_QUERY: &str = "London";

    // Normalize the key once here so all providers see the same invariant:
    // `Some(non-empty key)` or `None`. Callers (Tauri command shim, tests)
    // can pass whatever — empty/whitespace strings get rejected uniformly.
    let normalized_key = api_key.map(str::trim).filter(|k| !k.is_empty());

    match provider {
        GeocodeProvider::Nominatim => {
            // OSM's usage policy applies to ALL traffic, including the
            // Settings "test connection" probe — throttle to ≥1 req/s.
            nominatim_throttle().await;
            probe_simple(
                &format!(
                    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q={}",
                    urlencoding::encode(TEST_QUERY)
                ),
                true,
            )
            .await
        }
        GeocodeProvider::Photon => {
            probe_simple(
                &format!(
                    "https://photon.komoot.io/api/?limit=1&q={}",
                    urlencoding::encode(TEST_QUERY)
                ),
                true,
            )
            .await
        }
        GeocodeProvider::Mapbox => {
            let key = normalized_key.ok_or("missing_api_key")?;
            check_mapbox(TEST_QUERY, key).await
        }
        GeocodeProvider::MapTiler => {
            let key = normalized_key.ok_or("missing_api_key")?;
            check_maptiler(TEST_QUERY, key).await
        }
        GeocodeProvider::GooglePlaces => {
            let key = normalized_key.ok_or("missing_api_key")?;
            check_google(TEST_QUERY, key).await
        }
    }
}

/// Shared HTTP probe for key-less providers (Nominatim, Photon). We don't
/// read the body — the status code is the only signal we need.
async fn probe_simple(url: &str, send_user_agent: bool) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("reqwest client init is infallible on stock build");

    let mut req = client.get(url);
    if send_user_agent {
        req = req.header("User-Agent", user_agent());
    }
    let resp = req.send().await.map_err(|e| {
        log::warn!("Geocoding probe request failed: {e}");
        "network_error".to_string()
    })?;

    classify_http_status(resp.status())
}

/// Map an HTTP status code to one of our stable error codes, or `Ok(())`
/// for any 2xx response.
fn classify_http_status(status: reqwest::StatusCode) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    let code = status.as_u16();
    let err = match code {
        401 | 403 => "invalid_key",
        429 => "rate_limited",
        _ => "server_error",
    };
    Err(err.to_string())
}

async fn check_mapbox(query: &str, api_key: &str) -> Result<(), String> {
    let encoded_q = urlencoding::encode(query);
    let encoded_key = urlencoding::encode(api_key);
    let url = format!(
        "https://api.mapbox.com/geocoding/v5/mapbox.places/{encoded_q}.json?access_token={encoded_key}&limit=1&autocomplete=true"
    );

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("reqwest client init is infallible on stock build");
    let resp = client.get(&url).send().await.map_err(|e| {
        log::warn!(
            "Mapbox check request failed: {}",
            redact_secret(e.to_string(), api_key)
        );
        "network_error".to_string()
    })?;

    classify_http_status(resp.status())?;

    let text = resp.text().await.map_err(|e| {
        log::warn!(
            "Mapbox check response read failed: {}",
            redact_secret(e.to_string(), api_key)
        );
        "network_error".to_string()
    })?;

    // An empty `features` array on a `"London"` probe means the key was
    // accepted but isn't actually authorized to geocode (restricted token,
    // quota exhausted, etc.). Surface that as a real failure so the UI
    // doesn't show ✓ Working for a non-functional key.
    let parsed = parse_mapbox_response(&text).map_err(|_| "invalid_response".to_string())?;
    if parsed.is_empty() {
        return Err("invalid_response".to_string());
    }
    Ok(())
}

async fn check_maptiler(query: &str, api_key: &str) -> Result<(), String> {
    let encoded_q = urlencoding::encode(query);
    let encoded_key = urlencoding::encode(api_key);
    let url =
        format!("https://api.maptiler.com/geocoding/{encoded_q}.json?key={encoded_key}&limit=1");

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("reqwest client init is infallible on stock build");
    let resp = client.get(&url).send().await.map_err(|e| {
        log::warn!(
            "MapTiler check request failed: {}",
            redact_secret(e.to_string(), api_key)
        );
        "network_error".to_string()
    })?;

    classify_http_status(resp.status())?;

    let text = resp.text().await.map_err(|e| {
        log::warn!(
            "MapTiler check response read failed: {}",
            redact_secret(e.to_string(), api_key)
        );
        "network_error".to_string()
    })?;

    let parsed = parse_maptiler_response(&text).map_err(|_| "invalid_response".to_string())?;
    if parsed.is_empty() {
        return Err("invalid_response".to_string());
    }
    Ok(())
}

async fn check_google(query: &str, api_key: &str) -> Result<(), String> {
    let encoded_q = urlencoding::encode(query);
    let encoded_key = urlencoding::encode(api_key);
    let url = format!(
        "https://maps.googleapis.com/maps/api/place/autocomplete/json?input={encoded_q}&key={encoded_key}"
    );

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("reqwest client init is infallible on stock build");
    let resp = client.get(&url).send().await.map_err(|e| {
        log::warn!(
            "Google check request failed: {}",
            redact_secret(e.to_string(), api_key)
        );
        "network_error".to_string()
    })?;

    classify_http_status(resp.status())?;

    let text = resp.text().await.map_err(|e| {
        log::warn!(
            "Google check response read failed: {}",
            redact_secret(e.to_string(), api_key)
        );
        "network_error".to_string()
    })?;
    classify_google_status(&text)
}

/// Google returns HTTP 200 even for invalid keys — the real signal is the
/// `status` field in the JSON body. `REQUEST_DENIED` → invalid key,
/// `OVER_QUERY_LIMIT` → rate limited, `OK`/`ZERO_RESULTS` → working,
/// everything else → server_error.
pub fn classify_google_status(json: &str) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        status: Option<String>,
    }
    let resp: Resp = serde_json::from_str(json).map_err(|_| "invalid_response".to_string())?;
    match resp.status.as_deref() {
        Some("OK") | Some("ZERO_RESULTS") => Ok(()),
        // REQUEST_DENIED is the only Google status that means "your key is bad";
        // INVALID_REQUEST means the request itself was malformed (not the key).
        Some("REQUEST_DENIED") => Err("invalid_key".to_string()),
        Some("OVER_QUERY_LIMIT") => Err("rate_limited".to_string()),
        _ => Err("server_error".to_string()),
    }
}

// ─── Reverse geocoding helpers ───────────────────────────────────────────────

async fn nominatim_reverse(lat: f64, lng: f64) -> Result<Option<GeocodeSuggestion>, String> {
    let url = format!(
        "https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lng}&format=jsonv2&addressdetails=1"
    );
    nominatim_throttle().await;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Nominatim client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|e| format!("Nominatim reverse request failed: {e}"))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Nominatim reverse response read failed: {e}"))?;
    parse_nominatim_reverse_response(&text, lat, lng)
}

async fn photon_reverse(lat: f64, lng: f64) -> Result<Option<GeocodeSuggestion>, String> {
    let url = format!("https://photon.komoot.io/reverse?lat={lat}&lon={lng}");
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Photon client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|e| format!("Photon reverse request failed: {e}"))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Photon reverse response read failed: {e}"))?;
    // Photon's reverse endpoint returns the same GeoJSON shape as search,
    // so reuse the existing parser and take the first feature.
    let suggestions = parse_photon_response(&text)?;
    Ok(suggestions.into_iter().next())
}

async fn mapbox_reverse(
    lat: f64,
    lng: f64,
    api_key: &str,
) -> Result<Option<GeocodeSuggestion>, String> {
    // Mapbox expects `{lng},{lat}` order. limit=1 — we only show the best
    // match in the EXIF location suggestion modal.
    let url = format!(
        "https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json?access_token={api_key}&limit=1"
    );
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Mapbox client init failed: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| {
        let scrubbed = redact_secret(e.to_string(), api_key);
        format!("Mapbox reverse request failed: {scrubbed}")
    })?;
    let text = resp.text().await.map_err(|e| {
        let scrubbed = redact_secret(e.to_string(), api_key);
        format!("Mapbox reverse response read failed: {scrubbed}")
    })?;
    let suggestions = parse_mapbox_response(&text)?;
    Ok(suggestions.into_iter().next())
}

async fn maptiler_reverse(
    lat: f64,
    lng: f64,
    api_key: &str,
) -> Result<Option<GeocodeSuggestion>, String> {
    let encoded_key = urlencoding::encode(api_key);
    let url =
        format!("https://api.maptiler.com/geocoding/{lng},{lat}.json?key={encoded_key}&limit=1");
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("MapTiler client init failed: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| {
        let scrubbed = redact_secret(e.to_string(), api_key);
        format!("MapTiler reverse request failed: {scrubbed}")
    })?;
    let text = resp.text().await.map_err(|e| {
        let scrubbed = redact_secret(e.to_string(), api_key);
        format!("MapTiler reverse response read failed: {scrubbed}")
    })?;
    let suggestions = parse_maptiler_response(&text)?;
    Ok(suggestions.into_iter().next())
}

/// Nominatim's reverse endpoint returns a single object (not an array).
/// `place_id`/`display_name` may be missing for no-match coords (e.g. open
/// ocean) — those yield `Ok(None)` so callers fall back to coords.
pub fn parse_nominatim_reverse_response(
    json: &str,
    fallback_lat: f64,
    fallback_lng: f64,
) -> Result<Option<GeocodeSuggestion>, String> {
    #[derive(Debug, Deserialize)]
    struct ReverseResponse {
        place_id: Option<serde_json::Value>,
        display_name: Option<String>,
        lat: Option<String>,
        lon: Option<String>,
        name: Option<String>,
        #[serde(default)]
        error: Option<serde_json::Value>,
    }
    let obj: ReverseResponse =
        serde_json::from_str(json).map_err(|e| format!("Nominatim reverse parse error: {e}"))?;
    if obj.error.is_some() {
        return Ok(None);
    }
    let display_name = match obj.display_name {
        Some(d) if !d.is_empty() => d,
        _ => return Ok(None),
    };
    let place_id = match obj.place_id {
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::String(s)) => s,
        _ => format!("nominatim:{fallback_lat},{fallback_lng}"),
    };
    let label = obj.name.filter(|n| !n.is_empty()).unwrap_or_else(|| {
        display_name
            .split(',')
            .next()
            .unwrap_or(&display_name)
            .trim()
            .to_string()
    });
    let latitude = obj
        .lat
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(fallback_lat);
    let longitude = obj
        .lon
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(fallback_lng);
    Ok(Some(GeocodeSuggestion {
        place_id,
        label,
        address: display_name,
        latitude,
        longitude,
    }))
}

async fn google_reverse(
    lat: f64,
    lng: f64,
    api_key: &str,
) -> Result<Option<GeocodeSuggestion>, String> {
    // Google Maps Geocoding API reverse endpoint. Different from the
    // Places Autocomplete used for `geocode_search` — this one billable
    // per request under the "Geocoding API" SKU. result_type filtering
    // is left off so we get whatever Google considers the best match
    // (street_address, point_of_interest, locality, etc.).
    let url = format!(
        "https://maps.googleapis.com/maps/api/geocode/json?latlng={lat},{lng}&key={api_key}"
    );
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Google reverse client init failed: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| {
        let scrubbed = redact_secret(e.to_string(), api_key);
        format!("Google reverse request failed: {scrubbed}")
    })?;
    let text = resp.text().await.map_err(|e| {
        let scrubbed = redact_secret(e.to_string(), api_key);
        format!("Google reverse response read failed: {scrubbed}")
    })?;
    parse_google_reverse_response(&text, lat, lng).map_err(|e| redact_secret(e, api_key))
}

/// Parse the Google Geocoding reverse response. Top-level shape:
///   `{ "status": "OK", "results": [{ "formatted_address": "...",
///       "place_id": "...", "address_components": [...] }] }`
///
/// We extract the first result's `formatted_address` as the full address
/// and derive a short label from the most specific address component
/// (point_of_interest > establishment > street_address > route > locality).
/// `status != "OK"` yields `Ok(None)` (no-match) unless it's a hard error.
pub fn parse_google_reverse_response(
    json: &str,
    fallback_lat: f64,
    fallback_lng: f64,
) -> Result<Option<GeocodeSuggestion>, String> {
    #[derive(Debug, Deserialize)]
    struct AddressComponent {
        long_name: String,
        types: Vec<String>,
    }
    #[derive(Debug, Deserialize)]
    struct GeoLocation {
        lat: f64,
        lng: f64,
    }
    #[derive(Debug, Deserialize)]
    struct ResultGeometry {
        location: GeoLocation,
    }
    #[derive(Debug, Deserialize)]
    struct ReverseResult {
        formatted_address: String,
        place_id: String,
        #[serde(default)]
        address_components: Vec<AddressComponent>,
        geometry: ResultGeometry,
    }
    #[derive(Debug, Deserialize)]
    struct ReverseResponse {
        status: String,
        #[serde(default)]
        results: Vec<ReverseResult>,
        #[serde(default)]
        error_message: Option<String>,
    }

    let resp: ReverseResponse =
        serde_json::from_str(json).map_err(|e| format!("Google reverse parse error: {e}"))?;

    // ZERO_RESULTS is the no-match case — fall back to coords.
    if resp.status == "ZERO_RESULTS" {
        return Ok(None);
    }
    if resp.status != "OK" {
        let msg = resp
            .error_message
            .unwrap_or_else(|| format!("Google reverse status: {}", resp.status));
        return Err(msg);
    }
    let Some(first) = resp.results.into_iter().next() else {
        return Ok(None);
    };

    // Derive a short label from the most-specific component we can find.
    // Google tags components with `types` like ["point_of_interest"],
    // ["establishment"], ["route"], ["locality", "political"], etc. We
    // prefer named places, then street, then locality.
    const LABEL_PRIORITY: &[&str] = &[
        "point_of_interest",
        "establishment",
        "premise",
        "street_address",
        "route",
        "neighborhood",
        "sublocality",
        "locality",
        "administrative_area_level_2",
        "administrative_area_level_1",
        "country",
    ];
    let label = LABEL_PRIORITY
        .iter()
        .find_map(|target| {
            first
                .address_components
                .iter()
                .find(|c| c.types.iter().any(|t| t == target))
                .map(|c| c.long_name.clone())
        })
        .unwrap_or_else(|| {
            // Last-resort: first comma-separated chunk of the formatted address.
            first
                .formatted_address
                .split(',')
                .next()
                .unwrap_or(&first.formatted_address)
                .trim()
                .to_string()
        });

    Ok(Some(GeocodeSuggestion {
        place_id: first.place_id,
        label,
        address: first.formatted_address,
        latitude: if first.geometry.location.lat != 0.0 {
            first.geometry.location.lat
        } else {
            fallback_lat
        },
        longitude: if first.geometry.location.lng != 0.0 {
            first.geometry.location.lng
        } else {
            fallback_lng
        },
    }))
}

// ─── Provider-specific HTTP helpers ──────────────────────────────────────────

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

async fn nominatim_search(query: &str, limit: u32) -> Result<Vec<GeocodeSuggestion>, String> {
    let encoded = urlencoding::encode(query);
    let url = format!(
        "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit={limit}&q={encoded}"
    );

    nominatim_throttle().await;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Nominatim client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|e| format!("Nominatim request failed: {e}"))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Nominatim response read failed: {e}"))?;

    parse_nominatim_response(&text)
}

async fn photon_search(query: &str, limit: u32) -> Result<Vec<GeocodeSuggestion>, String> {
    let encoded = urlencoding::encode(query);
    let url = format!("https://photon.komoot.io/api/?q={encoded}&limit={limit}");

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Photon client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("User-Agent", user_agent())
        .send()
        .await
        .map_err(|e| format!("Photon request failed: {e}"))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Photon response read failed: {e}"))?;

    parse_photon_response(&text)
}

async fn mapbox_search(
    query: &str,
    api_key: &str,
    limit: u32,
) -> Result<Vec<GeocodeSuggestion>, String> {
    let encoded = urlencoding::encode(query);
    let url = format!(
        "https://api.mapbox.com/geocoding/v5/mapbox.places/{encoded}.json?access_token={api_key}&limit={limit}&autocomplete=true"
    );

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Mapbox client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| redact_secret(format!("Mapbox request failed: {e}"), api_key))?;

    let text = resp
        .text()
        .await
        .map_err(|e| redact_secret(format!("Mapbox response read failed: {e}"), api_key))?;

    parse_mapbox_response(&text)
}

async fn maptiler_search(
    query: &str,
    api_key: &str,
    limit: u32,
) -> Result<Vec<GeocodeSuggestion>, String> {
    let encoded = urlencoding::encode(query);
    let encoded_key = urlencoding::encode(api_key);
    let url = format!(
        "https://api.maptiler.com/geocoding/{encoded}.json?key={encoded_key}&limit={limit}"
    );

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("MapTiler client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| redact_secret(format!("MapTiler request failed: {e}"), api_key))?;

    let text = resp
        .text()
        .await
        .map_err(|e| redact_secret(format!("MapTiler response read failed: {e}"), api_key))?;

    parse_maptiler_response(&text)
}

async fn google_autocomplete_search(
    query: &str,
    api_key: &str,
    session_token: Option<&str>,
) -> Result<Vec<GeocodeSuggestion>, String> {
    let encoded = urlencoding::encode(query);
    let mut url = format!(
        "https://maps.googleapis.com/maps/api/place/autocomplete/json?input={encoded}&key={api_key}"
    );
    if let Some(token) = session_token {
        url.push_str(&format!("&sessiontoken={token}"));
    }

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Google client init failed: {e}"))?;
    let resp =
        client.get(&url).send().await.map_err(|e| {
            redact_secret(format!("Google autocomplete request failed: {e}"), api_key)
        })?;

    let text = resp.text().await.map_err(|e| {
        redact_secret(
            format!("Google autocomplete response read failed: {e}"),
            api_key,
        )
    })?;

    parse_google_autocomplete_response(&text)
}

async fn google_place_details(
    place_id: &str,
    api_key: &str,
    session_token: Option<&str>,
) -> Result<GeocodeSuggestion, String> {
    let encoded_id = urlencoding::encode(place_id);
    let mut url = format!(
        "https://maps.googleapis.com/maps/api/place/details/json?place_id={encoded_id}&fields=geometry,formatted_address,name&key={api_key}"
    );
    if let Some(token) = session_token {
        url.push_str(&format!("&sessiontoken={token}"));
    }

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Google client init failed: {e}"))?;
    let resp =
        client.get(&url).send().await.map_err(|e| {
            redact_secret(format!("Google place details request failed: {e}"), api_key)
        })?;

    let text = resp.text().await.map_err(|e| {
        redact_secret(
            format!("Google place details response read failed: {e}"),
            api_key,
        )
    })?;

    parse_google_place_details_response(&text)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── redact_secret tests live in `crate::utils::secrets` after the helper
    //    moved there for Phase 6 v2 R2. Geocoding callers re-export it via
    //    `use crate::utils::secrets::redact_secret;` at the top of this file.

    // ── GeocodeProvider::from_setting ────────────────────────────────────────

    #[test]
    fn provider_from_setting_defaults_to_photon() {
        assert_eq!(GeocodeProvider::from_setting(""), GeocodeProvider::Photon);
        assert_eq!(
            GeocodeProvider::from_setting("foo"),
            GeocodeProvider::Photon
        );
        assert_eq!(GeocodeProvider::from_setting("  "), GeocodeProvider::Photon);
        assert_eq!(
            GeocodeProvider::from_setting("unknown"),
            GeocodeProvider::Photon
        );
    }

    #[test]
    fn provider_from_setting_recognizes_known_values() {
        assert_eq!(
            GeocodeProvider::from_setting("nominatim"),
            GeocodeProvider::Nominatim
        );
        assert_eq!(
            GeocodeProvider::from_setting("photon"),
            GeocodeProvider::Photon
        );
        assert_eq!(
            GeocodeProvider::from_setting("mapbox"),
            GeocodeProvider::Mapbox
        );
        assert_eq!(
            GeocodeProvider::from_setting("google"),
            GeocodeProvider::GooglePlaces
        );
        // Case-insensitive
        assert_eq!(
            GeocodeProvider::from_setting("Photon"),
            GeocodeProvider::Photon
        );
        assert_eq!(
            GeocodeProvider::from_setting("Mapbox"),
            GeocodeProvider::Mapbox
        );
        assert_eq!(
            GeocodeProvider::from_setting("GOOGLE"),
            GeocodeProvider::GooglePlaces
        );
        assert_eq!(
            GeocodeProvider::from_setting("Nominatim"),
            GeocodeProvider::Nominatim
        );
        assert_eq!(
            GeocodeProvider::from_setting("maptiler"),
            GeocodeProvider::MapTiler
        );
        assert_eq!(
            GeocodeProvider::from_setting("MapTiler"),
            GeocodeProvider::MapTiler
        );
    }

    #[test]
    fn maptiler_parses_geojson_features() {
        let json = r#"{
            "features": [
                {
                    "id": "municipality.46425",
                    "text": "Paris",
                    "place_name": "Paris, France",
                    "center": [2.3522, 48.8566]
                }
            ]
        }"#;
        let results = parse_maptiler_response(json).expect("parse should succeed");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].place_id, "municipality.46425");
        assert_eq!(results[0].label, "Paris");
        assert_eq!(results[0].address, "Paris, France");
        assert!((results[0].longitude - 2.3522).abs() < 1e-4);
        assert!((results[0].latitude - 48.8566).abs() < 1e-4);
    }

    #[test]
    fn maptiler_parse_errors_on_invalid_json() {
        let result = parse_maptiler_response("{bad json}");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("MapTiler parse error"));
    }

    #[test]
    fn user_agent_contains_repo_url() {
        let ua = user_agent();
        assert!(
            ua.contains("https://github.com/dinhanhthi/memlore"),
            "User-Agent must include the public repo URL, got {ua}"
        );
        assert!(
            ua.starts_with("Memlore/"),
            "User-Agent must start with Memlore/<version>, got {ua}"
        );
    }

    #[test]
    fn nominatim_wait_none_is_zero() {
        let now = std::time::Instant::now();
        assert_eq!(nominatim_wait(None, now), std::time::Duration::ZERO);
    }

    #[test]
    fn nominatim_wait_300ms_ago_is_700ms() {
        let now = std::time::Instant::now();
        let last = now - std::time::Duration::from_millis(300);
        assert_eq!(
            nominatim_wait(Some(last), now),
            std::time::Duration::from_millis(700)
        );
    }

    #[test]
    fn nominatim_wait_2s_ago_is_zero() {
        let now = std::time::Instant::now();
        let last = now - std::time::Duration::from_secs(2);
        assert_eq!(nominatim_wait(Some(last), now), std::time::Duration::ZERO);
    }

    #[test]
    fn nominatim_wait_future_prev_spaces_off_reserved_fire_slot() {
        // `prev` is a *reserved future fire slot* (now + 700ms) that a prior
        // concurrent caller claimed. The next fire must be spaced a full
        // interval after that slot: 700ms + 1s = 1700ms — NOT clamped to 1s.
        let now = std::time::Instant::now();
        let last = now + std::time::Duration::from_millis(700);
        assert_eq!(
            nominatim_wait(Some(last), now),
            std::time::Duration::from_millis(1700)
        );
    }

    // ── Nominatim parse ──────────────────────────────────────────────────────

    #[test]
    fn nominatim_parses_real_response() {
        let json = r#"[
            {
                "place_id": 12345,
                "display_name": "Eiffel Tower, 5, Avenue Anatole France, Quartier du Champ-de-Mars, Paris, France",
                "name": "Eiffel Tower",
                "lat": "48.8584",
                "lon": "2.2945"
            },
            {
                "place_id": 67890,
                "display_name": "Tour Eiffel replica, Las Vegas, Nevada, USA",
                "name": "",
                "lat": "36.1147",
                "lon": "-115.1726"
            }
        ]"#;

        let results = parse_nominatim_response(json).expect("parse should succeed");
        assert_eq!(results.len(), 2);

        let first = &results[0];
        assert_eq!(first.place_id, "12345");
        assert_eq!(first.label, "Eiffel Tower");
        assert!((first.latitude - 48.8584).abs() < 1e-4);
        assert!((first.longitude - 2.2945).abs() < 1e-4);
        assert!(first.address.contains("Eiffel Tower"));

        // When name is empty, falls back to first comma segment of display_name
        let second = &results[1];
        assert_eq!(second.label, "Tour Eiffel replica");
        assert!((second.latitude - 36.1147).abs() < 1e-4);
        assert!((second.longitude - (-115.1726)).abs() < 1e-4);
    }

    #[test]
    fn nominatim_parse_errors_on_invalid_json() {
        let result = parse_nominatim_response("not json at all");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Nominatim parse error"));
    }

    // ── Nominatim reverse parse ──────────────────────────────────────────────

    #[test]
    fn nominatim_reverse_parses_typical_response() {
        let json = r#"{
            "place_id": 12345,
            "display_name": "Eiffel Tower, Champ de Mars, Paris, France",
            "lat": "48.85837",
            "lon": "2.29448",
            "name": "Eiffel Tower"
        }"#;
        let result = parse_nominatim_reverse_response(json, 48.858, 2.294)
            .expect("parse ok")
            .expect("should yield a suggestion");
        assert_eq!(result.label, "Eiffel Tower");
        assert_eq!(result.address, "Eiffel Tower, Champ de Mars, Paris, France");
        assert!((result.latitude - 48.85837).abs() < 1e-6);
        assert!((result.longitude - 2.29448).abs() < 1e-6);
    }

    #[test]
    fn nominatim_reverse_returns_none_on_error_object() {
        // Nominatim's no-match payload: `{"error": "Unable to geocode"}`.
        let json = r#"{ "error": "Unable to geocode" }"#;
        let result = parse_nominatim_reverse_response(json, 0.0, 0.0).expect("parse ok");
        assert!(result.is_none(), "ocean / no-match → None");
    }

    #[test]
    fn nominatim_reverse_falls_back_when_lat_lon_missing() {
        let json = r#"{ "display_name": "Some Place" }"#;
        let result = parse_nominatim_reverse_response(json, 1.2345, 6.7890)
            .expect("parse ok")
            .expect("yields suggestion when display_name exists");
        assert_eq!(result.label, "Some Place");
        assert!((result.latitude - 1.2345).abs() < 1e-9);
        assert!((result.longitude - 6.7890).abs() < 1e-9);
    }

    #[test]
    fn nominatim_reverse_returns_none_for_empty_display_name() {
        let json = r#"{ "display_name": "" }"#;
        let result = parse_nominatim_reverse_response(json, 0.0, 0.0).expect("parse ok");
        assert!(result.is_none());
    }

    // ── Google reverse parse ─────────────────────────────────────────────────

    #[test]
    fn google_reverse_extracts_point_of_interest_label() {
        let json = r#"{
            "status": "OK",
            "results": [
                {
                    "formatted_address": "Eiffel Tower, Champ de Mars, 5 Av. Anatole France, 75007 Paris, France",
                    "place_id": "ChIJLU7jZClu5kcR4PcOOO6p3I0",
                    "geometry": { "location": { "lat": 48.8584, "lng": 2.2945 } },
                    "address_components": [
                        { "long_name": "Eiffel Tower", "short_name": "Eiffel Tower", "types": ["point_of_interest", "establishment"] },
                        { "long_name": "Paris", "short_name": "Paris", "types": ["locality", "political"] }
                    ]
                }
            ]
        }"#;
        let result = parse_google_reverse_response(json, 48.858, 2.294)
            .expect("parse ok")
            .expect("yields suggestion");
        assert_eq!(result.label, "Eiffel Tower");
        assert!(result.address.contains("Champ de Mars"));
        assert!((result.latitude - 48.8584).abs() < 1e-4);
    }

    #[test]
    fn google_reverse_falls_back_to_locality_when_no_poi() {
        let json = r#"{
            "status": "OK",
            "results": [
                {
                    "formatted_address": "Paris, France",
                    "place_id": "ChIJD7fiBh9u5kcRYJSMaMOCCwQ",
                    "geometry": { "location": { "lat": 48.8566, "lng": 2.3522 } },
                    "address_components": [
                        { "long_name": "Paris", "short_name": "Paris", "types": ["locality", "political"] },
                        { "long_name": "France", "short_name": "FR", "types": ["country", "political"] }
                    ]
                }
            ]
        }"#;
        let result = parse_google_reverse_response(json, 0.0, 0.0)
            .expect("parse ok")
            .expect("yields suggestion");
        assert_eq!(result.label, "Paris");
    }

    #[test]
    fn google_reverse_returns_none_on_zero_results() {
        let json = r#"{ "status": "ZERO_RESULTS", "results": [] }"#;
        let result = parse_google_reverse_response(json, 0.0, 0.0).expect("parse ok");
        assert!(result.is_none());
    }

    #[test]
    fn google_reverse_returns_err_on_non_ok_status() {
        let json = r#"{
            "status": "REQUEST_DENIED",
            "error_message": "API key not authorized",
            "results": []
        }"#;
        let result = parse_google_reverse_response(json, 0.0, 0.0);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("API key") || msg.contains("REQUEST_DENIED"));
    }

    #[test]
    fn google_reverse_label_falls_back_to_first_address_chunk_when_no_priority_match() {
        // Only a non-priority `postal_code` component → label falls back
        // to the first comma-separated chunk of formatted_address.
        let json = r#"{
            "status": "OK",
            "results": [
                {
                    "formatted_address": "75007, France",
                    "place_id": "abc",
                    "geometry": { "location": { "lat": 0.0, "lng": 0.0 } },
                    "address_components": [
                        { "long_name": "75007", "short_name": "75007", "types": ["postal_code"] }
                    ]
                }
            ]
        }"#;
        let result = parse_google_reverse_response(json, 48.8, 2.3)
            .expect("parse ok")
            .expect("yields suggestion");
        assert_eq!(result.label, "75007");
        // geometry.location was 0.0 — falls back to the passed-in coords.
        assert!((result.latitude - 48.8).abs() < 1e-9);
    }

    // ── Photon parse ─────────────────────────────────────────────────────────

    #[test]
    fn photon_parses_real_response() {
        let json = r#"{
            "features": [
                {
                    "geometry": {"coordinates": [2.2945, 48.8584]},
                    "properties": {
                        "osm_id": 5013364,
                        "name": "Eiffel Tower",
                        "city": "Paris",
                        "country": "France",
                        "street": "Avenue Anatole France",
                        "housenumber": "5"
                    }
                },
                {
                    "geometry": {"coordinates": [2.3522, 48.8566]},
                    "properties": {
                        "osm_id": 7444,
                        "city": "Paris",
                        "country": "France"
                    }
                }
            ]
        }"#;

        let results = parse_photon_response(json).expect("parse should succeed");
        assert_eq!(results.len(), 2);

        let first = &results[0];
        assert_eq!(first.label, "Eiffel Tower");
        assert!(first.place_id.starts_with("photon:"));
        // Photon coordinates: [longitude, latitude]
        assert!((first.longitude - 2.2945).abs() < 1e-4);
        assert!((first.latitude - 48.8584).abs() < 1e-4);
        assert!(first.address.contains("Eiffel Tower"));
        assert!(first.address.contains("Paris"));

        // No name → falls back to city
        let second = &results[1];
        assert_eq!(second.label, "Paris");
        assert!((second.longitude - 2.3522).abs() < 1e-4);
        assert!((second.latitude - 48.8566).abs() < 1e-4);
    }

    #[test]
    fn photon_parse_errors_on_invalid_json() {
        let result = parse_photon_response("not json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Photon parse error"));
    }

    #[test]
    fn photon_parse_empty_features() {
        let json = r#"{"features": []}"#;
        let results = parse_photon_response(json).expect("empty is valid");
        assert!(results.is_empty());
    }

    // ── Mapbox parse ─────────────────────────────────────────────────────────

    #[test]
    fn mapbox_parses_real_response() {
        let json = r#"{
            "features": [
                {
                    "id": "poi.123456",
                    "text": "Eiffel Tower",
                    "place_name": "Eiffel Tower, Paris, Île-de-France, France",
                    "center": [2.2945, 48.8584]
                },
                {
                    "id": "place.789",
                    "text": "Paris",
                    "place_name": "Paris, Île-de-France, France",
                    "center": [2.3522, 48.8566]
                }
            ]
        }"#;

        let results = parse_mapbox_response(json).expect("parse should succeed");
        assert_eq!(results.len(), 2);

        let first = &results[0];
        assert_eq!(first.place_id, "poi.123456");
        assert_eq!(first.label, "Eiffel Tower");
        assert_eq!(first.address, "Eiffel Tower, Paris, Île-de-France, France");
        // center is [lng, lat]
        assert!((first.longitude - 2.2945).abs() < 1e-4);
        assert!((first.latitude - 48.8584).abs() < 1e-4);

        let second = &results[1];
        assert_eq!(second.label, "Paris");
        assert!((second.longitude - 2.3522).abs() < 1e-4);
        assert!((second.latitude - 48.8566).abs() < 1e-4);
    }

    #[test]
    fn mapbox_parse_errors_on_invalid_json() {
        let result = parse_mapbox_response("{bad json}");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Mapbox parse error"));
    }

    // ── Google Autocomplete parse ─────────────────────────────────────────────

    #[test]
    fn google_autocomplete_parses_predictions() {
        let json = r#"{
            "predictions": [
                {
                    "place_id": "ChIJD7fiBh9u5kcRYJSMaMOCCwQ",
                    "description": "Paris, France",
                    "structured_formatting": {
                        "main_text": "Paris"
                    }
                },
                {
                    "place_id": "ChIJ2z2bKkuNpBIRAvEBNdgGDgE",
                    "description": "Paris, TX, USA"
                }
            ],
            "status": "OK"
        }"#;

        let results = parse_google_autocomplete_response(json).expect("parse should succeed");
        assert_eq!(results.len(), 2);

        let first = &results[0];
        assert_eq!(first.place_id, "ChIJD7fiBh9u5kcRYJSMaMOCCwQ");
        assert_eq!(first.label, "Paris");
        assert_eq!(first.address, "Paris, France");
        // Lat/lng are 0.0 placeholders for autocomplete results
        assert!((first.latitude - 0.0).abs() < f64::EPSILON);
        assert!((first.longitude - 0.0).abs() < f64::EPSILON);

        // When no structured_formatting, fall back to first comma segment
        let second = &results[1];
        assert_eq!(second.label, "Paris");
        assert_eq!(second.address, "Paris, TX, USA");
    }

    #[test]
    fn google_autocomplete_parse_errors_on_invalid_json() {
        let result = parse_google_autocomplete_response("bad");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Google autocomplete parse error"));
    }

    // ── Google Place Details parse ────────────────────────────────────────────

    #[test]
    fn google_place_details_parses_geometry() {
        let json = r#"{
            "result": {
                "place_id": "ChIJD7fiBh9u5kcRYJSMaMOCCwQ",
                "name": "Paris",
                "formatted_address": "Paris, France",
                "geometry": {
                    "location": {
                        "lat": 48.8566,
                        "lng": 2.3522
                    }
                }
            },
            "status": "OK"
        }"#;

        let result = parse_google_place_details_response(json).expect("parse should succeed");
        assert_eq!(result.place_id, "ChIJD7fiBh9u5kcRYJSMaMOCCwQ");
        assert_eq!(result.label, "Paris");
        assert_eq!(result.address, "Paris, France");
        assert!((result.latitude - 48.8566).abs() < 1e-4);
        assert!((result.longitude - 2.3522).abs() < 1e-4);
    }

    #[test]
    fn google_place_details_parse_errors_on_invalid_json() {
        let result = parse_google_place_details_response("not json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Google place details parse error"));
    }

    // ── Blank query short-circuit ─────────────────────────────────────────────

    #[tokio::test]
    async fn search_with_blank_query_returns_empty() {
        // Empty string — no HTTP call
        let result = search(GeocodeProvider::Nominatim, "", None, 5, None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());

        // Whitespace-only — no HTTP call
        let result = search(GeocodeProvider::Nominatim, "   ", None, 5, None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());

        // Also short-circuits for paid providers (no key needed since no call is made)
        let result = search(GeocodeProvider::GooglePlaces, "", None, 5, Some("tok")).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    // ── resolve_place errors for non-Google providers ────────────────────────

    #[tokio::test]
    async fn resolve_place_returns_error_for_nominatim() {
        let result = resolve_place(GeocodeProvider::Nominatim, "12345", None, None).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "resolve_place not needed for this provider"
        );
    }

    #[tokio::test]
    async fn resolve_place_returns_error_for_photon() {
        let result = resolve_place(GeocodeProvider::Photon, "photon:123", None, None).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "resolve_place not needed for this provider"
        );
    }

    #[tokio::test]
    async fn resolve_place_returns_error_for_mapbox() {
        let result = resolve_place(GeocodeProvider::Mapbox, "poi.123", Some("key"), None).await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "resolve_place not needed for this provider"
        );
    }

    #[tokio::test]
    async fn resolve_place_not_needed_for_maptiler() {
        let result = resolve_place(
            GeocodeProvider::MapTiler,
            "municipality.1",
            Some("key"),
            None,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "resolve_place not needed for this provider"
        );
    }

    // ── check classification ─────────────────────────────────────────────────

    #[test]
    fn classify_http_status_treats_2xx_as_ok() {
        assert!(classify_http_status(reqwest::StatusCode::OK).is_ok());
        assert!(classify_http_status(reqwest::StatusCode::NO_CONTENT).is_ok());
    }

    #[test]
    fn classify_http_status_maps_auth_to_invalid_key() {
        assert_eq!(
            classify_http_status(reqwest::StatusCode::UNAUTHORIZED).unwrap_err(),
            "invalid_key"
        );
        assert_eq!(
            classify_http_status(reqwest::StatusCode::FORBIDDEN).unwrap_err(),
            "invalid_key"
        );
    }

    #[test]
    fn classify_http_status_maps_429_to_rate_limited() {
        assert_eq!(
            classify_http_status(reqwest::StatusCode::TOO_MANY_REQUESTS).unwrap_err(),
            "rate_limited"
        );
    }

    #[test]
    fn classify_http_status_maps_other_non_2xx_to_server_error() {
        assert_eq!(
            classify_http_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR).unwrap_err(),
            "server_error"
        );
        assert_eq!(
            classify_http_status(reqwest::StatusCode::BAD_REQUEST).unwrap_err(),
            "server_error"
        );
    }

    #[test]
    fn classify_google_status_ok_for_ok_and_zero_results() {
        assert!(classify_google_status(r#"{"status":"OK","predictions":[]}"#).is_ok());
        assert!(classify_google_status(r#"{"status":"ZERO_RESULTS"}"#).is_ok());
    }

    #[test]
    fn classify_google_status_maps_request_denied_to_invalid_key() {
        let json =
            r#"{"status":"REQUEST_DENIED","error_message":"The provided API key is invalid."}"#;
        assert_eq!(classify_google_status(json).unwrap_err(), "invalid_key");
    }

    #[test]
    fn classify_google_status_maps_invalid_request_to_server_error() {
        // INVALID_REQUEST means the request was malformed, not that the key
        // is bad — must not be confused with REQUEST_DENIED.
        let json = r#"{"status":"INVALID_REQUEST"}"#;
        assert_eq!(classify_google_status(json).unwrap_err(), "server_error");
    }

    #[test]
    fn classify_google_status_maps_over_query_limit_to_rate_limited() {
        let json = r#"{"status":"OVER_QUERY_LIMIT"}"#;
        assert_eq!(classify_google_status(json).unwrap_err(), "rate_limited");
    }

    #[test]
    fn classify_google_status_maps_unknown_to_server_error() {
        let json = r#"{"status":"UNKNOWN_ERROR"}"#;
        assert_eq!(classify_google_status(json).unwrap_err(), "server_error");
    }

    #[test]
    fn classify_google_status_maps_unparseable_to_invalid_response() {
        assert_eq!(
            classify_google_status("not json").unwrap_err(),
            "invalid_response"
        );
    }

    #[tokio::test]
    async fn check_returns_missing_api_key_for_maptiler_without_key() {
        let result = check(GeocodeProvider::MapTiler, None).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn check_returns_missing_api_key_for_mapbox_without_key() {
        let result = check(GeocodeProvider::Mapbox, None).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn check_returns_missing_api_key_for_google_without_key() {
        let result = check(GeocodeProvider::GooglePlaces, None).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn check_treats_empty_key_as_missing_for_mapbox() {
        let result = check(GeocodeProvider::Mapbox, Some("")).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }

    #[tokio::test]
    async fn check_treats_whitespace_key_as_missing_for_google() {
        let result = check(GeocodeProvider::GooglePlaces, Some("   ")).await;
        assert_eq!(result.unwrap_err(), "missing_api_key");
    }
}
