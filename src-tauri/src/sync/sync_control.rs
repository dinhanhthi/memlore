//! `.meta/control.json` — the mode-independent cloud recovery authority.
//!
//! This file is never deleted (even by a full cloud wipe/rebuild): its stable
//! Drive file ID makes conditional updates usable as the recovery-lease CAS
//! (compare-and-swap). It tracks the current recovery generation and, while a
//! danger-zone recovery operation is in flight, an exclusive lease so peers
//! fail closed instead of racing a wipe/rebuild.
//!
//! Historical note: this module used to also hold a none-mode-specific
//! `.meta/mode.json` marker (`ModeMarkerV1`) that let devices detect a
//! plaintext cloud folder before committing OAuth credentials. The
//! always-encrypted rewrite removed none-mode entirely, so that marker (and
//! its `SharedFileIO` download/upload helpers) was deleted — there is no
//! plaintext cloud folder shape to disambiguate anymore. `SyncControlV1`
//! itself was always mode-independent and is unaffected.

use serde::{Deserialize, Serialize};

pub const SYNC_CONTROL_VERSION: u32 = 1;
pub const SYNC_CONTROL_DRIVE_PATH: &str = ".meta/control.json";

/// Mode-independent cloud authority. This file is never deleted: its stable
/// Drive file ID makes conditional updates usable as the recovery lease CAS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncControlV1 {
    pub version: u32,
    pub recovery_generation: u64,
    pub recovery_lease: Option<crate::sync::keyring_v2::RecoveryMarker>,
    pub updated_at: i64,
}

impl SyncControlV1 {
    pub fn initial(now_unix: i64) -> Self {
        Self {
            version: SYNC_CONTROL_VERSION,
            recovery_generation: 0,
            recovery_lease: None,
            updated_at: now_unix,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != SYNC_CONTROL_VERSION {
            return Err(format!(
                "Unsupported sync control version: {} (expected {})",
                self.version, SYNC_CONTROL_VERSION
            ));
        }
        if self.updated_at < 0 {
            return Err("updated_at must be non-negative".to_string());
        }
        if let Some(lease) = &self.recovery_lease {
            lease.validate()?;
            if lease.recovery_generation != self.recovery_generation {
                return Err("recovery lease generation must match control generation".to_string());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_control_allows_initial_zero_and_positive_generation() {
        let initial = SyncControlV1::initial(1);
        initial.validate().unwrap();
        assert_eq!(initial.recovery_generation, 0);

        let adopted = SyncControlV1 {
            recovery_generation: 7,
            updated_at: 2,
            ..initial
        };
        adopted.validate().unwrap();
        assert_eq!(adopted.recovery_generation, 7);
    }

    /// Build a lease that is valid on its own, pinned to `generation`.
    fn lease_at(generation: u64) -> crate::sync::keyring_v2::RecoveryMarker {
        let lease = crate::sync::keyring_v2::RecoveryMarker {
            version: crate::sync::keyring_v2::RECOVERY_MARKER_VERSION,
            job_id: 1,
            // Must be hex chars + '-' only, per `validate_device_id`.
            owner_device_id: "abc123-def456".to_string(),
            // Must be one of local_to_cloud / cloud_to_local / cloud_cleanup.
            operation: "cloud_cleanup".to_string(),
            recovery_generation: generation,
            // Must be >= 16 hex characters.
            nonce: "0123456789abcdef".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        lease.validate().expect("helper must build a valid lease");
        lease
    }

    #[test]
    fn sync_control_rejects_unsupported_version() {
        let control = SyncControlV1 {
            version: SYNC_CONTROL_VERSION + 1,
            ..SyncControlV1::initial(1)
        };
        let err = control.validate().unwrap_err();
        assert!(
            err.contains("Unsupported sync control version"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn sync_control_rejects_negative_updated_at() {
        let control = SyncControlV1 {
            updated_at: -1,
            ..SyncControlV1::initial(1)
        };
        let err = control.validate().unwrap_err();
        assert!(err.contains("updated_at"), "unexpected error: {err}");
    }

    /// Fail-closed guard for the recovery-lease CAS: a lease pinned to a
    /// different generation than the control file must be rejected, so a peer
    /// cannot act on a stale lease and race a cloud wipe/rebuild.
    #[test]
    fn sync_control_rejects_lease_generation_mismatch() {
        let control = SyncControlV1 {
            recovery_generation: 5,
            recovery_lease: Some(lease_at(4)),
            ..SyncControlV1::initial(1)
        };
        let err = control.validate().unwrap_err();
        assert!(
            err.contains("recovery lease generation must match"),
            "unexpected error: {err}"
        );
    }

    /// The matching-generation case must still pass — proves the mismatch test
    /// above fails for the generation check and not for some unrelated reason.
    #[test]
    fn sync_control_accepts_lease_with_matching_generation() {
        let control = SyncControlV1 {
            recovery_generation: 5,
            recovery_lease: Some(lease_at(5)),
            ..SyncControlV1::initial(1)
        };
        control.validate().unwrap();
    }

    /// An individually-invalid lease must be rejected via `lease.validate()`,
    /// even when its generation matches.
    #[test]
    fn sync_control_rejects_invalid_lease_itself() {
        let mut lease = lease_at(5);
        lease.version = crate::sync::keyring_v2::RECOVERY_MARKER_VERSION + 1;
        let control = SyncControlV1 {
            recovery_generation: 5,
            recovery_lease: Some(lease),
            ..SyncControlV1::initial(1)
        };
        assert!(control.validate().is_err());
    }
}
