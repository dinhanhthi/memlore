//! V2 per-device keyring — structs, cloud I/O helpers, and crypto wiring.
//!
//! Phase 1: structs + path constants + I/O helpers.
//! Phase 2: builder (crash-safe initial publish) + crypto wiring.

pub mod builder;
pub mod io;
pub mod types;

// Re-export the items callers are most likely to need.
pub use builder::publish_initial_v2_keyring;
pub use io::{
    delete_device_slot, device_slot_path, list_device_slots, read_content, read_device_slot,
    read_meta, read_recovery, read_recovery_marker, write_content, write_device_slot, write_meta,
    write_recovery, ConditionalMutationResult, KeyringV2Io, VersionedFile, CONTENT_PATH,
    DEVICES_DIR, KEYRING_DIR, META_PATH, RECOVERY_MARKER_PATH, RECOVERY_PATH,
};
pub use types::{
    ContentEntryV2, ContentListV2, DeviceSlotV2, KeyringMetaV2, RecoveryMarker, RecoverySlotV2,
    KEYRING_V2_VERSION, RECOVERY_MARKER_VERSION,
};
