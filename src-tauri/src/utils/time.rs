//! Time helpers.
//!
//! `now_unix` used to be duplicated across `db::queries` and
//! `sync::engine`. One copy here keeps the semantics — "current UNIX
//! timestamp in seconds, 0 on clock skew" — in a single place.

/// Current UNIX timestamp in seconds. Returns 0 if the system clock is
/// before the UNIX epoch (rare; indicates a broken clock).
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_unix_is_close_to_current_epoch() {
        let ts = now_unix();
        // Loose bounds: any run between 2020-01-01 and year 2100.
        assert!(ts > 1_577_836_800, "now_unix() = {ts} — broken clock?");
        assert!(ts < 4_102_444_800, "now_unix() = {ts} — future clock?");
    }
}
