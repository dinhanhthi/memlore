use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherData {
    pub summary: String,
    pub icon: String,
    pub temperature: f64,
}

/// Which Open-Meteo endpoint(s) to query for a target calendar day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WeatherSource {
    /// Entry date is today — use the live current-weather endpoint.
    Current,
    /// Recent past or near future — try forecast daily, fall back to archive.
    ForecastThenArchive,
    /// Older than the forecast window — archive only.
    ArchiveOnly,
}

/// Map WMO weather interpretation codes to emoji icons and descriptions.
pub fn wmo_to_weather(code: i64, temperature: f64) -> WeatherData {
    let (icon, desc) = match code {
        0 => ("☀️", "Clear sky"),
        1 => ("🌤️", "Mainly clear"),
        2 => ("⛅", "Partly cloudy"),
        3 => ("☁️", "Overcast"),
        45 | 48 => ("🌫️", "Foggy"),
        51 | 53 | 55 => ("🌦️", "Drizzle"),
        56 | 57 => ("🌧️", "Freezing drizzle"),
        61 | 63 | 65 => ("🌧️", "Rain"),
        66 | 67 => ("🌧️", "Freezing rain"),
        71 | 73 | 75 => ("🌨️", "Snow"),
        77 => ("🌨️", "Snow grains"),
        80 | 81 | 82 => ("🌧️", "Rain showers"),
        85 | 86 => ("🌨️", "Snow showers"),
        95 => ("⛈️", "Thunderstorm"),
        96 | 99 => ("⛈️", "Thunderstorm with hail"),
        _ => ("🌡️", "Unknown"),
    };
    WeatherData {
        summary: format!("{}, {:.0}°C", desc, temperature),
        icon: icon.to_string(),
        temperature,
    }
}

/// Convert a Unix-seconds entry timestamp to an ISO date (`YYYY-MM-DD`).
/// Uses UTC so the backend stays timezone-agnostic; Open-Meteo interprets
/// `start_date`/`end_date` in the location's local timezone via `timezone=auto`.
pub fn entry_date_to_iso(entry_date: i64) -> Result<String, String> {
    let dt = DateTime::<Utc>::from_timestamp(entry_date, 0)
        .ok_or_else(|| format!("Invalid entry_date timestamp: {entry_date}"))?;
    Ok(dt.date_naive().format("%Y-%m-%d").to_string())
}

/// Decide which Open-Meteo source to use for `target` relative to `today`.
fn select_weather_source(today: NaiveDate, target: NaiveDate) -> WeatherSource {
    if target == today {
        return WeatherSource::Current;
    }

    let days_ago = today.signed_duration_since(target).num_days();

    // Forecast API covers recent past + near future; archive handles older dates.
    if (0..=FORECAST_PAST_DAYS).contains(&days_ago) || target > today {
        WeatherSource::ForecastThenArchive
    } else {
        WeatherSource::ArchiveOnly
    }
}

/// Map a single-day Open-Meteo daily payload to `WeatherData`.
fn daily_weather_for_date(
    times: &[String],
    weather_codes: &[i64],
    temperatures: &[f64],
    date: &str,
) -> Result<WeatherData, String> {
    let idx = times
        .iter()
        .position(|d| d == date)
        .ok_or_else(|| format!("No weather data for {date}"))?;

    let code = *weather_codes
        .get(idx)
        .ok_or_else(|| format!("Missing weather code for {date}"))?;
    let temp = *temperatures
        .get(idx)
        .ok_or_else(|| format!("Missing temperature for {date}"))?;

    Ok(wmo_to_weather(code, temp))
}

/// Open-Meteo current-weather response structure.
#[derive(Debug, Deserialize)]
struct OpenMeteoResponse {
    current_weather: CurrentWeather,
}

#[derive(Debug, Deserialize)]
struct CurrentWeather {
    temperature: f64,
    weathercode: i64,
}

/// Open-Meteo daily aggregate response (forecast + archive share this shape).
#[derive(Debug, Deserialize)]
struct DailyWeatherResponse {
    daily: DailyWeather,
}

#[derive(Debug, Deserialize)]
struct DailyWeather {
    time: Vec<String>,
    weather_code: Vec<i64>,
    temperature_2m_mean: Vec<f64>,
}

/// How many days back the forecast API can serve before we fall back to
/// the historical archive endpoint.
const FORECAST_PAST_DAYS: i64 = 16;

/// Fetch weather for the given coordinates. When `entry_date` is provided,
/// returns weather for that calendar day (historical archive or recent
/// forecast); when omitted, returns current conditions.
pub async fn fetch_weather(
    latitude: f64,
    longitude: f64,
    entry_date: Option<i64>,
) -> Result<WeatherData, String> {
    match entry_date {
        None => fetch_current_weather(latitude, longitude).await,
        Some(ts) => fetch_weather_for_date(latitude, longitude, ts).await,
    }
}

async fn fetch_current_weather(latitude: f64, longitude: f64) -> Result<WeatherData, String> {
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current_weather=true"
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Weather API request failed: {e}"))?;

    let data: OpenMeteoResponse = resp
        .json()
        .await
        .map_err(|e| format!("Weather API response parse failed: {e}"))?;

    Ok(wmo_to_weather(
        data.current_weather.weathercode,
        data.current_weather.temperature,
    ))
}

async fn fetch_weather_for_date(
    latitude: f64,
    longitude: f64,
    entry_date: i64,
) -> Result<WeatherData, String> {
    let target_date = entry_date_to_iso(entry_date)?;
    let today = Utc::now().date_naive();
    let parsed = NaiveDate::parse_from_str(&target_date, "%Y-%m-%d")
        .map_err(|e| format!("Invalid entry date: {e}"))?;

    match select_weather_source(today, parsed) {
        WeatherSource::Current => fetch_current_weather(latitude, longitude).await,
        WeatherSource::ForecastThenArchive => {
            match fetch_daily_weather_forecast(latitude, longitude, &target_date).await {
                Ok(data) => Ok(data),
                Err(err) => {
                    log::warn!(
                        "forecast daily weather for {target_date} failed, trying archive: {err}"
                    );
                    fetch_daily_weather_archive(latitude, longitude, &target_date).await
                }
            }
        }
        WeatherSource::ArchiveOnly => {
            fetch_daily_weather_archive(latitude, longitude, &target_date).await
        }
    }
}

async fn fetch_daily_weather_forecast(
    latitude: f64,
    longitude: f64,
    date: &str,
) -> Result<WeatherData, String> {
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}\
         &start_date={date}&end_date={date}\
         &daily=weather_code,temperature_2m_mean&timezone=auto"
    );
    fetch_daily_weather_from_url(&url, date).await
}

async fn fetch_daily_weather_archive(
    latitude: f64,
    longitude: f64,
    date: &str,
) -> Result<WeatherData, String> {
    let url = format!(
        "https://archive-api.open-meteo.com/v1/archive?latitude={latitude}&longitude={longitude}\
         &start_date={date}&end_date={date}\
         &daily=weather_code,temperature_2m_mean&timezone=auto"
    );
    fetch_daily_weather_from_url(&url, date).await
}

async fn fetch_daily_weather_from_url(url: &str, date: &str) -> Result<WeatherData, String> {
    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("Weather API request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Weather API returned HTTP {}",
            resp.status().as_u16()
        ));
    }

    let data: DailyWeatherResponse = resp
        .json()
        .await
        .map_err(|e| format!("Weather API response parse failed: {e}"))?;

    daily_weather_for_date(
        &data.daily.time,
        &data.daily.weather_code,
        &data.daily.temperature_2m_mean,
        date,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn wmo_to_weather_clear_sky() {
        let w = wmo_to_weather(0, 25.0);
        assert_eq!(w.icon, "☀️");
        assert_eq!(w.summary, "Clear sky, 25°C");
        assert!((w.temperature - 25.0).abs() < f64::EPSILON);
    }

    #[test]
    fn wmo_to_weather_rain() {
        let w = wmo_to_weather(61, 12.0);
        assert_eq!(w.icon, "🌧️");
        assert!(w.summary.starts_with("Rain,"));
    }

    #[test]
    fn wmo_to_weather_thunderstorm() {
        let w = wmo_to_weather(95, 18.0);
        assert_eq!(w.icon, "⛈️");
        assert!(w.summary.starts_with("Thunderstorm,"));
    }

    #[test]
    fn wmo_to_weather_unknown_code() {
        let w = wmo_to_weather(999, 10.0);
        assert_eq!(w.icon, "🌡️");
        assert!(w.summary.starts_with("Unknown,"));
    }

    #[test]
    fn wmo_to_weather_mainly_clear() {
        let w = wmo_to_weather(1, 20.0);
        assert_eq!(w.icon, "🌤️");
    }

    #[test]
    fn wmo_to_weather_thunderstorm_with_hail() {
        let w = wmo_to_weather(99, 5.0);
        assert_eq!(w.icon, "⛈️");
        assert!(w.summary.starts_with("Thunderstorm with hail,"));
    }

    #[test]
    fn wmo_to_weather_snow() {
        let w = wmo_to_weather(73, -5.0);
        assert_eq!(w.icon, "🌨️");
        assert!(w.summary.starts_with("Snow,"));
    }

    #[test]
    fn wmo_to_weather_formats_negative_temperature() {
        let w = wmo_to_weather(0, -3.0);
        assert_eq!(w.summary, "Clear sky, -3°C");
    }

    #[test]
    fn entry_date_to_iso_converts_unix_seconds() {
        // 2024-06-15 12:00:00 UTC
        let iso = entry_date_to_iso(1_718_452_800).unwrap();
        assert_eq!(iso, "2024-06-15");
    }

    #[test]
    fn entry_date_to_iso_rejects_invalid_timestamp() {
        assert!(entry_date_to_iso(i64::MAX).is_err());
    }

    #[test]
    fn select_weather_source_today_uses_current() {
        let today = d(2026, 7, 5);
        assert_eq!(select_weather_source(today, today), WeatherSource::Current);
    }

    #[test]
    fn select_weather_source_recent_past_uses_forecast() {
        let today = d(2026, 7, 5);
        let target = d(2026, 7, 4);
        assert_eq!(
            select_weather_source(today, target),
            WeatherSource::ForecastThenArchive
        );
    }

    #[test]
    fn select_weather_source_boundary_day_16_uses_forecast() {
        let today = d(2026, 7, 5);
        let target = today - chrono::Duration::days(FORECAST_PAST_DAYS);
        assert_eq!(
            select_weather_source(today, target),
            WeatherSource::ForecastThenArchive
        );
    }

    #[test]
    fn select_weather_source_boundary_day_17_uses_archive() {
        let today = d(2026, 7, 5);
        let target = today - chrono::Duration::days(FORECAST_PAST_DAYS + 1);
        assert_eq!(
            select_weather_source(today, target),
            WeatherSource::ArchiveOnly
        );
    }

    #[test]
    fn select_weather_source_future_date_uses_forecast() {
        let today = d(2026, 7, 5);
        let target = d(2026, 7, 10);
        assert_eq!(
            select_weather_source(today, target),
            WeatherSource::ForecastThenArchive
        );
    }

    #[test]
    fn daily_weather_for_date_maps_matching_day() {
        let result =
            daily_weather_for_date(&["2024-06-15".to_string()], &[61], &[12.0], "2024-06-15")
                .unwrap();
        assert_eq!(result.icon, "🌧️");
        assert_eq!(result.summary, "Rain, 12°C");
    }

    #[test]
    fn daily_weather_for_date_errors_when_date_missing() {
        let err = daily_weather_for_date(&["2024-06-14".to_string()], &[61], &[12.0], "2024-06-15")
            .unwrap_err();
        assert!(err.contains("No weather data for 2024-06-15"));
    }

    #[test]
    fn daily_weather_for_date_errors_when_weather_code_missing() {
        let err = daily_weather_for_date(&["2024-06-15".to_string()], &[], &[12.0], "2024-06-15")
            .unwrap_err();
        assert!(err.contains("Missing weather code for 2024-06-15"));
    }

    #[test]
    fn daily_weather_for_date_errors_when_temperature_missing() {
        let err = daily_weather_for_date(&["2024-06-15".to_string()], &[61], &[], "2024-06-15")
            .unwrap_err();
        assert!(err.contains("Missing temperature for 2024-06-15"));
    }
}
