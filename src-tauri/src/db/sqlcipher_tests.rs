// SQLCipher integration tests using HKDF-derived keys (Phase 5b).
// These complement `key_tests` in mod.rs (which covers wrong-key rejection and
// correct-key roundtrip) with lock/unlock simulation, fingerprint rotation, and
// the missing-PRAGMA-key failure case.
#[cfg(test)]
mod tests {
    use crate::db;
    use crate::utils::encryption::{derive_sqlcipher_key, key_fingerprint};
    use tempfile::NamedTempFile;

    // ── lock / unlock simulation ─────────────────────────────────────────────

    #[test]
    fn lock_then_unlock_with_correct_key_succeeds() {
        let master = [0xAAu8; 32];
        let key = derive_sqlcipher_key(&master);

        let tmp = NamedTempFile::new().expect("tempfile");
        let path = tmp.path().to_str().expect("path");

        // "Locked" state: open, write, close (drop).
        {
            let conn = db::open_with_key(path, &key).expect("initial open");
            conn.execute_batch(
                "INSERT INTO settings (key, value) VALUES ('lock_test', 'unlocked');",
            )
            .expect("insert");
        }

        // Simulate lock: the connection is dropped (file closed). On unlock the
        // master is re-derived from the same passphrase; we re-derive the
        // SQLCipher sub-key here to represent that.
        let key_again = derive_sqlcipher_key(&master);
        let conn2 = db::open_with_key(path, &key_again).expect("reopen after simulated lock");
        let val: String = conn2
            .query_row(
                "SELECT value FROM settings WHERE key = 'lock_test'",
                [],
                |row| row.get(0),
            )
            .expect("select after unlock");

        assert_eq!(val, "unlocked", "data must survive lock/unlock cycle");
    }

    // ── key fingerprint changes on password change ───────────────────────────

    #[test]
    fn key_fingerprint_changes_on_password_change() {
        let master_old = [0xBBu8; 32];
        let master_new = [0xCCu8; 32];

        let sqlcipher_old = derive_sqlcipher_key(&master_old);
        let sqlcipher_new = derive_sqlcipher_key(&master_new);

        let fp_old = key_fingerprint(&sqlcipher_old);
        let fp_new = key_fingerprint(&sqlcipher_new);

        assert_ne!(
            fp_old, fp_new,
            "fingerprint must change when the master key (password) changes — \
             this drives the 'key swap needed' decision in swap_local_key"
        );
    }

    // ── missing PRAGMA key → query fails ────────────────────────────────────

    #[test]
    fn connection_without_pragma_key_fails_to_query() {
        let master = [0xDDu8; 32];
        let key = derive_sqlcipher_key(&master);

        let tmp = NamedTempFile::new().expect("tempfile");
        let path = tmp.path().to_str().expect("path");

        // Write an encrypted DB.
        {
            let conn = db::open_with_key(path, &key).expect("write encrypted db");
            conn.execute_batch("INSERT INTO settings (key, value) VALUES ('secret', 'data');")
                .expect("insert");
            conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
                .expect("checkpoint");
        }

        // Open with `init_db` (no PRAGMA key) — schema::migrate touches page 1,
        // which triggers SQLITE_NOTADB.
        let result = db::init_db(path);
        assert!(
            result.is_err(),
            "opening an SQLCipher DB without PRAGMA key must fail, got Ok"
        );
    }
}
