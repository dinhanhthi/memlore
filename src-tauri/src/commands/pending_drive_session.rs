//! Process-wide map of deferred cloud-connect session material.
//!
//! ## Purpose
//!
//! When connect determines local mode is `Unset`, it cannot yet persist
//! provider settings — the user must complete onboarding or first-time-setup
//! first. This module holds a [`PendingCloudSession`] (Drive OAuth material
//! or a folder root) in memory between the two phases.
//!
//! ## Design
//!
//! A static `OnceLock<Mutex<State>>` is used instead of `indexmap`/`once_cell`/
//! `lazy_static` because those crates are not yet in the dependency tree. LRU
//! eviction is implemented with a `VecDeque<String>` that mirrors insertion
//! order; size-eviction pops from the front after each insert. Expired entries
//! are pruned on every read/write access.
//!
//! **Security constraint:** [`PendingCloudSession`] and [`PendingDriveSession`]
//! intentionally do NOT implement `Serialize` or `Deserialize`. The GDrive
//! arm holds a refresh token via `GDriveSession`; it must never cross an IPC
//! boundary.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::sync::gdrive_provider::GDriveSession;

// ─── Constants ────────────────────────────────────────────────────────────────

/// Maximum lifetime for a pending session entry. Typed entry of a recovery
/// phrase can be slow; 30 minutes gives ample time.
pub const TTL: Duration = Duration::from_secs(30 * 60);

/// Maximum number of concurrent pending sessions. LRU eviction (oldest by
/// insertion order) fires when a new entry would exceed this cap.
pub const MAX_SIZE: usize = 8;

// ─── Public types ─────────────────────────────────────────────────────────────

/// Deferred cloud-connect material held between connect (Unset-mode path)
/// and the onboarding / first-time-setup commands.
///
/// **NOT Serializable** — the `GDrive` arm embeds a refresh token that must
/// never leak across IPC boundaries.
#[derive(Clone, Debug)]
pub enum PendingCloudSession {
    GDrive {
        session: GDriveSession,
        /// Drive root folder id captured by `ensure_folder_structure` during
        /// `gdrive_complete_connect`. Stashed for future consumers that may
        /// need to publish into the folder without re-creating it.
        #[allow(dead_code)]
        root_folder_id: String,
    },
    /// Filesystem provider (`"icloud"` or `"local"`) with a vault root path.
    /// Constructed by `cloud_folder_connect` (Phase 3 task 3).
    #[allow(dead_code)]
    Folder { kind: String, root_path: String },
}

/// Map entry wrapping [`PendingCloudSession`] with insertion time.
///
/// **NOT Serializable** — see [`PendingCloudSession`].
pub struct PendingDriveSession {
    pub session: PendingCloudSession,
    /// Wall-clock instant of insertion. Public so tests can forge stale entries
    /// directly (avoids sleeping; see test `entry_past_ttl_is_dropped_on_next_access`).
    pub created_at: Instant,
}

// ─── Internal state ───────────────────────────────────────────────────────────

struct State {
    map: HashMap<String, PendingDriveSession>,
    /// Tracks insertion order for LRU size-eviction: oldest key at the front.
    order: VecDeque<String>,
}

impl State {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

static STORE: OnceLock<Mutex<State>> = OnceLock::new();

fn store() -> &'static Mutex<State> {
    STORE.get_or_init(|| Mutex::new(State::new()))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Remove all entries whose `created_at` is older than `TTL`.
/// Must be called while holding the `State` lock.
fn prune_expired(state: &mut State) {
    let now = Instant::now();
    state
        .map
        .retain(|_, v| now.duration_since(v.created_at) < TTL);
    state.order.retain(|k| state.map.contains_key(k));
}

/// Evict the oldest entry (by insertion order) while the map exceeds `MAX_SIZE`.
/// Must be called while holding the `State` lock.
fn evict_lru(state: &mut State) {
    while state.map.len() > MAX_SIZE {
        if let Some(oldest) = state.order.pop_front() {
            state.map.remove(&oldest);
        } else {
            break;
        }
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Insert a pending session. Expired entries are pruned first; the oldest
/// entry (by insertion order) is evicted if the map would exceed `MAX_SIZE`
/// after insertion.
pub fn stash(session_id: String, value: PendingDriveSession) {
    let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
    prune_expired(&mut guard);
    guard.order.push_back(session_id.clone());
    guard.map.insert(session_id, value);
    evict_lru(&mut guard);
}

/// Return a clone of the embedded [`PendingCloudSession`] for `session_id`
/// WITHOUT removing the entry. Used by read-only consumers that need a
/// provider (e.g. `onboard_validate_passphrase`) but must leave the pending
/// session available for the eventual `consume` inside `onboard_complete`.
/// Prunes expired entries as a housekeeping pass.
pub fn peek(session_id: &str) -> Option<PendingCloudSession> {
    let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
    prune_expired(&mut guard);
    guard.map.get(session_id).map(|p| p.session.clone())
}

/// Remove and return the pending session for `session_id`, if it exists and
/// has not expired. Also prunes other expired entries as a housekeeping pass.
pub fn consume(session_id: &str) -> Option<PendingCloudSession> {
    let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
    prune_expired(&mut guard);
    let entry = guard.map.remove(session_id);
    if entry.is_some() {
        guard.order.retain(|k| k.as_str() != session_id);
    }
    entry.map(|p| p.session)
}

/// Clear the entire map. Only available in test builds — allows each test
/// to start from a clean, deterministic state.
#[cfg(test)]
pub fn reset() {
    let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
    guard.map.clear();
    guard.order.clear();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use zeroize::Zeroizing;

    fn make_session(tag: &str) -> GDriveSession {
        GDriveSession {
            access_token: format!("at_{tag}"),
            expires_at: Instant::now() + Duration::from_secs(3600),
            refresh_token: Zeroizing::new(format!("rt_{tag}")),
            client_id: format!("cid_{tag}"),
            client_secret: format!("cs_{tag}"),
        }
    }

    fn make_pending(tag: &str) -> PendingDriveSession {
        PendingDriveSession {
            session: PendingCloudSession::GDrive {
                session: make_session(tag),
                root_folder_id: format!("root_{tag}"),
            },
            created_at: Instant::now(),
        }
    }

    /// Test 1 — stash then consume returns the same values.
    #[test]
    #[serial]
    fn stash_then_consume_round_trip() {
        reset();
        let session = make_session("a");
        stash(
            "id_a".to_string(),
            PendingDriveSession {
                session: PendingCloudSession::GDrive {
                    session,
                    root_folder_id: "root_a".to_string(),
                },
                created_at: Instant::now(),
            },
        );
        let got = consume("id_a").expect("should be present after stash");
        match got {
            PendingCloudSession::GDrive {
                session,
                root_folder_id,
            } => {
                assert_eq!(root_folder_id, "root_a");
                assert_eq!(session.access_token, "at_a");
                assert_eq!(&*session.refresh_token, "rt_a");
                assert_eq!(session.client_id, "cid_a");
                assert_eq!(session.client_secret, "cs_a");
            }
            PendingCloudSession::Folder { .. } => panic!("expected GDrive session"),
        }
    }

    /// Test 2 — consuming an unknown session_id returns None.
    #[test]
    #[serial]
    fn consume_unknown_returns_none() {
        reset();
        assert!(consume("does_not_exist").is_none());
    }

    /// Test 3 — after consume, a second consume of the same id returns None.
    #[test]
    #[serial]
    fn consume_removes_entry() {
        reset();
        stash("id_b".to_string(), make_pending("b"));
        assert!(consume("id_b").is_some(), "first consume should succeed");
        assert!(consume("id_b").is_none(), "second consume should be None");
    }

    /// Test 4 — stash MAX_SIZE+1 entries; the first one is evicted.
    #[test]
    #[serial]
    fn stash_evicts_oldest_at_max_size_plus_one() {
        reset();
        // Stash MAX_SIZE+1 = 9 entries: s1..s9.
        for i in 1..=(MAX_SIZE + 1) {
            stash(format!("s{i}"), make_pending(&format!("s{i}")));
        }
        // s1 is the oldest insertion; it should have been evicted.
        assert!(
            consume("s1").is_none(),
            "s1 should have been LRU-evicted after s9 was stashed"
        );
        // s2..s9 must all still be present.
        for i in 2..=(MAX_SIZE + 1) {
            assert!(
                consume(&format!("s{i}")).is_some(),
                "s{i} should still be present"
            );
        }
    }

    /// Test 5 — an entry inserted with a forged stale `created_at` is dropped
    /// on the next access (no sleeping required).
    #[test]
    #[serial]
    fn entry_past_ttl_is_dropped_on_next_access() {
        reset();
        // Insert a stale entry directly via stash, then overwrite created_at.
        // Because the struct is in the same crate, tests can forge the field.
        {
            let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
            guard.map.insert(
                "stale".to_string(),
                PendingDriveSession {
                    session: PendingCloudSession::GDrive {
                        session: make_session("stale"),
                        root_folder_id: "root_stale".to_string(),
                    },
                    // created_at is far in the past — already expired
                    created_at: Instant::now() - TTL - Duration::from_secs(1),
                },
            );
            guard.order.push_back("stale".to_string());
        }

        // Stashing a fresh entry triggers prune_expired, which removes the
        // stale key.
        stash("fresh".to_string(), make_pending("fresh"));

        // The stale entry must be gone.
        assert!(
            consume("stale").is_none(),
            "stale entry should have been pruned"
        );
        // The fresh entry must still be present.
        assert!(
            consume("fresh").is_some(),
            "fresh entry should still be present"
        );
    }

    /// Test — peek returns a clone of the session without removing it; a
    /// subsequent consume still succeeds.
    #[test]
    #[serial]
    fn peek_does_not_remove() {
        reset();
        stash("p1".to_string(), make_pending("p1"));
        let peeked = peek("p1").expect("peek must return the entry");
        match peeked {
            PendingCloudSession::GDrive { session, .. } => {
                assert_eq!(session.access_token, "at_p1");
                assert_eq!(&*session.refresh_token, "rt_p1");
            }
            PendingCloudSession::Folder { .. } => panic!("expected GDrive session"),
        }
        // Original entry still consumable.
        let consumed = consume("p1").expect("consume after peek must succeed");
        match consumed {
            PendingCloudSession::GDrive { session, .. } => {
                assert_eq!(session.access_token, "at_p1");
            }
            PendingCloudSession::Folder { .. } => panic!("expected GDrive session"),
        }
        // Second consume now empty.
        assert!(consume("p1").is_none());
    }

    /// Test — peek returns None for unknown id.
    #[test]
    #[serial]
    fn peek_unknown_returns_none() {
        reset();
        assert!(peek("does_not_exist").is_none());
    }

    /// Test — peek returns None for expired entry AND prunes it.
    #[test]
    #[serial]
    fn peek_expired_returns_none() {
        reset();
        {
            let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
            guard.map.insert(
                "stale_peek".to_string(),
                PendingDriveSession {
                    session: PendingCloudSession::GDrive {
                        session: make_session("stale_peek"),
                        root_folder_id: "root_stale_peek".to_string(),
                    },
                    created_at: Instant::now() - TTL - Duration::from_secs(1),
                },
            );
            guard.order.push_back("stale_peek".to_string());
        }
        assert!(peek("stale_peek").is_none());
        // Verify it was pruned (subsequent consume also None).
        assert!(consume("stale_peek").is_none());
    }

    /// Test 6 — reset() clears all entries.
    #[test]
    #[serial]
    fn reset_clears_the_map() {
        reset();
        stash("r1".to_string(), make_pending("r1"));
        stash("r2".to_string(), make_pending("r2"));
        reset();
        assert!(consume("r1").is_none(), "r1 should be cleared by reset");
        assert!(consume("r2").is_none(), "r2 should be cleared by reset");
    }

    #[test]
    #[serial]
    fn peek_and_consume_return_folder_session() {
        reset();
        stash(
            "folder_1".to_string(),
            PendingDriveSession {
                session: PendingCloudSession::Folder {
                    kind: "icloud".to_string(),
                    root_path: "/tmp/xj-icloud".to_string(),
                },
                created_at: Instant::now(),
            },
        );
        let peeked = peek("folder_1").expect("peek must return the Folder session");
        match peeked {
            PendingCloudSession::Folder { kind, root_path } => {
                assert_eq!(kind, "icloud");
                assert_eq!(root_path, "/tmp/xj-icloud");
            }
            PendingCloudSession::GDrive { .. } => panic!("peek must return Folder, not GDrive"),
        }
        let consumed = consume("folder_1").expect("consume after peek must succeed");
        match consumed {
            PendingCloudSession::Folder { kind, root_path } => {
                assert_eq!(kind, "icloud");
                assert_eq!(root_path, "/tmp/xj-icloud");
            }
            PendingCloudSession::GDrive { .. } => panic!("consume must return Folder, not GDrive"),
        }
        assert!(consume("folder_1").is_none());
    }
}
