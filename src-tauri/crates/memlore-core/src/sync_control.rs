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

use crate::keyring_types::RecoveryMarker;

pub const SYNC_CONTROL_VERSION: u32 = 1;
pub const SYNC_CONTROL_DRIVE_PATH: &str = ".meta/control.json";

/// Mode-independent cloud authority. This file is never deleted: its stable
/// Drive file ID makes conditional updates usable as the recovery lease CAS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncControlV1 {
    pub version: u32,
    pub recovery_generation: u64,
    pub recovery_lease: Option<crate::keyring_types::RecoveryMarker>,
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

/// Copy of the desktop `RecoveryOwnerPermit` (`sync/recovery.rs`): the plain
/// description of the recovery job that owns the active cloud marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryOwnerPermit {
    pub job_id: i64,
    pub owner_device_id: String,
    pub operation: String,
    pub recovery_generation: u64,
    pub nonce: String,
}

/// Copy of the pure decision logic of the desktop `authorize_recovery_push`.
/// The desktop keeps its own function; a parity test there pins identical
/// outcomes and byte-identical error strings (they reach `SyncError::Auth`).
pub fn authorize_recovery_push(
    marker: Option<&RecoveryMarker>,
    cloud_generation: u64,
    local_generation: u64,
    permit: Option<&RecoveryOwnerPermit>,
) -> Result<(), String> {
    match (marker, permit) {
        (None, None) => {
            if cloud_generation != local_generation {
                return Err(format!(
                    "recovery generation mismatch: cloud={cloud_generation}, local={local_generation}"
                ));
            }
            Ok(())
        }
        (Some(_), None) => Err("authoritative recovery marker blocks normal sync".to_string()),
        (None, Some(_)) => Err("recovery owner permit requires an active cloud marker".to_string()),
        (Some(marker), Some(permit)) => {
            if marker.job_id != permit.job_id
                || marker.owner_device_id != permit.owner_device_id
                || marker.operation != permit.operation
                || marker.recovery_generation != permit.recovery_generation
                || marker.nonce != permit.nonce
                || local_generation != permit.recovery_generation
                || cloud_generation > permit.recovery_generation
            {
                return Err(
                    "recovery owner permit does not match cloud marker/generation".to_string(),
                );
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_control_json_roundtrip_and_validate() {
        let initial = SyncControlV1::initial(1);
        initial.validate().unwrap();
        let json = serde_json::to_string(&initial).unwrap();
        let back: SyncControlV1 = serde_json::from_str(&json).unwrap();
        assert_eq!(back, initial);
        assert!(serde_json::from_str::<SyncControlV1>(
            r#"{"version":1,"recovery_generation":0,"recovery_lease":null,"updated_at":1,"x":1}"#
        )
        .is_err());
    }
}
