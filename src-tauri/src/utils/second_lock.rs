use argon2::{
    password_hash::{PasswordHash, PasswordHasher, SaltString},
    Argon2, PasswordVerifier,
};

pub fn hash_second_lock_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(rand::thread_rng());
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("Failed to hash second-lock password: {e}"))
}

pub fn verify_second_lock_password(password: &str, phc: &str) -> bool {
    let Ok(parsed_hash) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_password_hash_verifies_correct_password_only() {
        let hash = hash_second_lock_password("correct horse battery staple").unwrap();

        assert!(verify_second_lock_password(
            "correct horse battery staple",
            &hash
        ));
        assert!(!verify_second_lock_password("wrong password", &hash));
    }

    #[test]
    fn second_lock_password_hash_uses_unique_salts() {
        let a = hash_second_lock_password("same password").unwrap();
        let b = hash_second_lock_password("same password").unwrap();

        assert_ne!(a, b, "each hash should carry a fresh salt");
        assert!(a.starts_with("$argon2"));
        assert!(b.starts_with("$argon2"));
    }

    #[test]
    fn malformed_second_lock_hash_does_not_verify() {
        assert!(!verify_second_lock_password("anything", "not-a-phc-hash"));
    }
}
