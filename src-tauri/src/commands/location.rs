use crate::db::{self, LocationAlias};
use crate::AppState;
use tauri::State;

/// Validate GPS coordinates: must be finite and within valid ranges.
fn validate_coords(lat: f64, lon: f64) -> Result<(), String> {
    if !lat.is_finite() || !lon.is_finite() {
        return Err("Invalid coordinates: values must be finite numbers".to_string());
    }
    if !(-90.0..=90.0).contains(&lat) {
        return Err(format!(
            "Latitude {lat} out of range: must be between -90 and 90"
        ));
    }
    if !(-180.0..=180.0).contains(&lon) {
        return Err(format!(
            "Longitude {lon} out of range: must be between -180 and 180"
        ));
    }
    Ok(())
}

/// Create a new location alias.
#[tauri::command]
pub fn create_location_alias(
    state: State<'_, AppState>,
    label: String,
    address: String,
    latitude: f64,
    longitude: f64,
    radius_meters: Option<f64>,
) -> Result<LocationAlias, String> {
    validate_coords(latitude, longitude)?;
    if let Some(r) = radius_meters {
        if !r.is_finite() || r <= 0.0 {
            return Err("radius_meters must be a positive number".to_string());
        }
    }
    let conn = state.lock()?;
    db::create_location_alias(&conn, &label, &address, latitude, longitude, radius_meters)
        .map_err(|e| e.to_string())
}

/// List all location aliases ordered by label.
#[tauri::command]
pub fn list_location_aliases(state: State<'_, AppState>) -> Result<Vec<LocationAlias>, String> {
    let conn = state.lock()?;
    db::list_location_aliases(&conn).map_err(|e| e.to_string())
}

/// Get a single location alias by id.
#[tauri::command]
pub fn get_location_alias(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<LocationAlias>, String> {
    let conn = state.lock()?;
    db::get_location_alias(&conn, &id).map_err(|e| e.to_string())
}

/// Update an existing location alias.
#[tauri::command]
pub fn update_location_alias(
    state: State<'_, AppState>,
    id: String,
    label: String,
    address: String,
    latitude: f64,
    longitude: f64,
    radius_meters: Option<f64>,
) -> Result<LocationAlias, String> {
    validate_coords(latitude, longitude)?;
    if let Some(r) = radius_meters {
        if !r.is_finite() || r <= 0.0 {
            return Err("radius_meters must be a positive number".to_string());
        }
    }
    let conn = state.lock()?;
    db::update_location_alias(
        &conn,
        &id,
        &label,
        &address,
        latitude,
        longitude,
        radius_meters,
    )
    .map_err(|e| e.to_string())
}

/// Delete a location alias by id.
#[tauri::command]
pub fn delete_location_alias(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.lock()?;
    db::delete_location_alias(&conn, &id).map_err(|e| e.to_string())
}

/// Find aliases whose radius covers the given coordinates.
#[tauri::command]
pub fn find_nearby_aliases(
    state: State<'_, AppState>,
    latitude: f64,
    longitude: f64,
) -> Result<Vec<LocationAlias>, String> {
    validate_coords(latitude, longitude)?;
    let conn = state.lock()?;
    db::find_nearby_aliases(&conn, latitude, longitude).map_err(|e| e.to_string())
}
