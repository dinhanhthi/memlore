pub mod backup;
pub mod conversion;
pub mod embeddings;
pub mod filters;
pub mod google_fonts_catalog;
pub mod invisible_vaults;
pub mod memory;
pub mod paging;
pub mod persona;
pub mod queries;
pub mod schema;
pub mod seeds;

#[cfg(test)]
mod sqlcipher_tests;

pub use backup::*;
pub use filters::{EmotionKey, HasMediaFilter, SearchFilters, TimeRangeFilter};
pub use invisible_vaults::*;
pub use paging::{clamp_page, page_limit, page_offset, PagedResult, PAGE_SIZE};
pub use queries::*;

use rusqlite::{Connection, Result};

/// Bootstrap SQLCipher key used to create and open all fresh file databases
/// before the user sets a passphrase.
///
/// Every on-disk DB is created encrypted with this well-known all-zeros key so
/// that `PRAGMA rekey` (which only works on already-encrypted databases) can
/// later rotate it to the real HKDF-derived user key. A DB opened with this key
/// is NOT plain SQLite — the first 16 bytes are NOT `SQLite format 3`.
///
/// The bootstrap key is publicly known by design. It is rotated to the
/// user-derived key the moment `setup_first_time` (password mode) completes.
/// Before that rotation the DB contains only schema and template-seed data,
/// not user journal entries.
pub const BOOTSTRAP_SQLCIPHER_KEY: [u8; 32] = [0u8; 32];

/// Open a SQLite database at the given path, run migrations, and return the
/// connection. Called once at app startup.
///
/// # Panics (debug builds)
/// Logs a warning when `path` is `":memory:"` — in-memory databases lose all
/// data on restart and must not be used in production builds.
pub fn init_db(path: &str) -> Result<Connection> {
    if path == ":memory:" {
        log::warn!(
            "Database opened in memory — all data will be lost on restart. \
             This is only correct in tests. Wire up app_data_dir in Chunk 3."
        );
    }
    let conn = Connection::open(path)?;
    schema::migrate(&conn)?;
    Ok(conn)
}

/// Open an existing SQLCipher-encrypted database, apply `PRAGMA key` as the
/// very first SQL statement, then run idempotent schema migrations.
///
/// `key` must be the HKDF-derived 32-byte SQLCipher sub-key (see
/// `utils::encryption::derive_sqlcipher_key`). Passing the raw Argon2id master
/// key here is a bug — the HKDF split ensures the SQLCipher key is independent
/// of the sync-envelope key.
///
/// Returns `Err` if the key is wrong (SQLCipher returns SQLITE_NOTADB on the
/// first page read) or if migration fails.
pub fn open_with_key(path: &str, key: &[u8; 32]) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // PRAGMA key MUST be the first statement — before any DML, DDL, or other
    // pragmas. SQLCipher uses it to decrypt page 1 on the next SQL that
    // touches actual data.
    let hex = hex::encode(key);
    conn.pragma_update(None, "key", format!("x'{hex}'"))?;
    schema::migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod key_tests {
    use super::*;
    use crate::utils::encryption::derive_sqlcipher_key;
    use tempfile::NamedTempFile;

    #[test]
    fn open_with_key_roundtrips_data() {
        let master_a = [0x11u8; 32];
        let master_b = [0x22u8; 32];
        let key_a = derive_sqlcipher_key(&master_a);
        let key_b = derive_sqlcipher_key(&master_b);

        let tmp = NamedTempFile::new().expect("tempfile");
        let path = tmp.path().to_str().expect("path as str");

        // Create an encrypted DB with key A, insert a row.
        {
            let conn = open_with_key(path, &key_a).expect("open with key A");
            conn.execute_batch("INSERT INTO settings (key, value) VALUES ('test_k', 'hello');")
                .expect("insert");
        }

        // Reopen with wrong key B — schema::migrate reads data so open_with_key
        // itself must fail with SQLITE_NOTADB.
        {
            let result = open_with_key(path, &key_b);
            assert!(
                result.is_err(),
                "wrong key must cause open_with_key to fail"
            );
        }

        // Reopen with correct key A — row must be readable.
        {
            let conn_a2 = open_with_key(path, &key_a).expect("reopen with key A");
            let val: String = conn_a2
                .query_row(
                    "SELECT value FROM settings WHERE key = 'test_k'",
                    [],
                    |row| row.get(0),
                )
                .expect("select with correct key");
            assert_eq!(val, "hello");
        }
    }
}
