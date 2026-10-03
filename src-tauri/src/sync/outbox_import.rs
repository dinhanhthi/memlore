//! Outbox Importer — Desktop Ingest of Web Companion Intents
//!
//! This module documents and implements the desktop-side outbox importer (Phases 13 & 14)
//! for the Memlore Web Companion (`web.memlore.app`).
//!
//! # Architecture & Safety Principles
//!
//! The web companion operates under a strict "outbox" model:
//! 1. The web NEVER writes sync-protocol files (`metadata.json`, `entries/`, `media/`, `journals/`).
//! 2. The web writes sealed intents into `generations/g-<N>/<webId>/outbox/`:
//!    - `outbox/<entryId>.bin`: one intent file per entry, updated in place.
//!    - `outbox/m-<mediaId>` and `outbox/m-<mediaId>.thumb`: flat layout, 3-part logical paths
//!      (`<dev>/outbox/<file>`), compliant with `parse_drive_path` (`gdrive_provider.rs:1729-1742`).
//! 3. Desktop is primary: desktops apply intents through their own local code paths, then
//!    publish the result as normal desktop sync files. Older desktops without this importer
//!    ignore the outbox completely because `<webId>` has no `metadata.json`.
//!
//! ---
//!
//! ## (a) Desktop Consumers & Namespace Isolation
//!
//! Every device-folder consumer in the desktop codebase has been verified:
//! - **Manifest pull:** `engine.rs:5143` and `engine.rs:5213-5218` iterate devices and pull only
//!   when `metadata.json` is present. Because `<webId>` never writes `metadata.json`, all
//!   desktop pull pipelines skip the web device folder.
//! - **Whole-table channels:** settings, tags, templates, streak, locations, and ai channels
//!   ignore missing files (NotFound -> continue). Chats and memory are manifest-gated.
//! - **New desktop-written file `{self}/outbox-acks.bin`:**
//!   - Placed at the root of the desktop's OWN folder.
//!   - **Rotation enumeration (`rotation/enumerate.rs:154-237`):**
//!     Rotation enumerates `FileKind::Entries`, `FileKind::Media`, `FileKind::Journals`,
//!     `FileKind::Versions`, and a fixed list `SINGLETON_BLOB_NAMES` (`enumerate.rs:223-235`).
//!     It does NOT glob or list all root files; `{self}/outbox-acks.bin` is not in
//!     `SINGLETON_BLOB_NAMES` and is therefore ignored during rotation re-encryption.
//!   - **Own-cloud reconcile (`engine.rs:693-730`):**
//!     `FileKind::DeviceRoot` listing compares against `HASH_GATED_SURFACE_NAMES` (`engine.rs:728`).
//!     Extra files like `outbox-acks.bin` do not match any surface name and are ignored without error.
//! - **Destructive flows touching the web namespace:**
//!   - **Cloud cleanup (`gdrive_provider.rs:1358-1396`, `recovery.rs:1457-1486`):**
//!     Deletes all children of the `Memlore` root except `.meta/control.json` and recovery markers
//!     preserved by `preserve_during_cloud_cleanup`. This cleanly purges all device folders,
//!     including web outbox folders and `{self}/outbox-acks.bin`.
//!   - **Key rotation `publish_keyring` (`rotation/publish.rs:198-216`):**
//!     `kio::delete_device_slot(provider, &slot.device_id)` deletes every non-rotator device slot
//!     under `.meta/keyring/devices/`. Web slots are dropped, revoking decryption of new content.
//!   - **Remove device (`commands/crypto.rs:3933-3953`):**
//!     `remove_device_inner` calls `delete_device_slot` on the cloud provider and deletes the
//!     local device record, leaving cloud outbox files untouched until cloud cleanup.
//!
//! ---
//!
//! ## (b) Provider Listing API & Device Slot Discovery
//!
//! - **Subfolder listing:**
//!   In `gdrive_provider.rs:1145-1148`, `list_subfolder_files` checks `find_folder(subfolder, ...)`.
//!   If the subfolder does not exist, it returns `Ok(vec![])`. Listing `outbox` on a device
//!   folder without an outbox cleanly returns empty.
//! - **Device slot discovery:**
//!   `KeyringV2Io::list_device_slots` (`keyring_v2/io.rs:318`) lists `.meta/keyring/devices/*.json`.
//!   In `commands/sync.rs:880` and `commands/crypto.rs:3747`, `refresh_devices_from_cloud_impl`
//!   calls `list_device_slots(&provider)` to discover registered devices.
//!
//! ---
//!
//! ## (c) Building Blocks Reused by the Importer
//!
//! Following the precedent established in `commands/mcp.rs`:
//! - **Write guards (`commands/mcp.rs:357-395`):**
//!   `require_writable_entry` refuses locked, invisible, or deleted entries.
//!   `visible_journal` verifies that the target journal exists and is neither deleted nor invisible.
//! - **Emotion & tag validation:**
//!   `validate_emotion` (`mcp.rs:425`) enforces 3-state emotion values (`good`, `neutral`, `bad`).
//!   Tag IDs require a new ID-based query `existing_tag_ids(conn, ids)` because
//!   `resolve_existing_tag_ids` (`mcp.rs:396-416`) looks up tags by name and errors on unknown tags.
//! - **Yrs Yjs text extraction:**
//!   Yjs text is extracted using yrs transactions. The frontend already computes `contentText`
//!   and `previewText` in the outbox payload (`OutboxEntryV1`), but desktop verification
//!   or fallback can walk the `default` text type of the merged `Y.Doc`.
//! - **Editor live diff bridge (`commands/mcp.rs:306`, `src/hooks/useMcpEntryEvents.ts:24-33`):**
//!   `encode_diff_v1(&sv_before)` emits `mcp:entry-changed` so an open TipTap editor absorbs changes.
//! - **Content persistence:**
//!   `save_entry_content_impl` (`commands/entries.rs:334-346`) persists `yjs_doc`, `content_text`,
//!   and `preview_text` in a transaction.
//! - **Embedding indexing & language detection:**
//!   `maybe_mark_entry_embedding_dirty_after_save` (`commands/entries.rs:38`) queues embedding
//!   dirty jobs and detects language.
//! - **Size limits:**
//!   `MAX_YJS_DOC_BYTES` (`commands/entries.rs:1052`, 10 MiB) guards document size.
//! - **Version snapshots:**
//!   `snapshot_entry_version_impl` (`commands/entries.rs:1322`) records an immutable history snapshot.
//! - **Media handling:**
//!   `get_media_upload_limits` / `get_media_upload_limits_inner` (`commands/media.rs:1993`) checks quotas.
//!   The media file creation pattern (`commands/media.rs:242`) saves media under `media_dir`.
//!
//! ---
//!
//! ## (d) Field Setters & `updated_at` Timestamp Contracts
//!
//! Setters in `db/queries.rs`:
//! - `create_entry` (`queries.rs:1046`): stamps `now_unix()`.
//! - `update_entry_emotion` (`queries.rs:2633`): stamps `now_unix()`.
//! - `update_entry_title` (`queries.rs:2687`): stamps `now_unix()`.
//! - `update_entry_date` (`queries.rs:2705`): stamps `now_unix()`.
//! - `update_entry_journal` (`queries.rs:2733`): stamps `now_unix()`.
//! - `set_entry_language` (`queries.rs:3504-3516`): stamps `now_unix()`.
//! - `mark_entry_date_user_edited` (`queries.rs:2723`): flags `entry_date_user_edited = 1` without bumping `updated_at`.
//! - `touch_entry_updated_at` (`queries.rs:3145`): uses `MAX(?1, updated_at + 1)` to ensure monotonicity.
//! - Tag associations (`commands/tags.rs:115, 129`): call `touch_entry_updated_at`.
//!
//! ---
//!
//! ## (e) `sync_state` Reset Invariants & Reset Hooks
//!
//! The additive table `web_outbox_imports` must be cleared ONLY on true user-data wipe:
//! - **Clear table on:**
//!   1. `hard_wipe_user_data` (`queries.rs:689-701`).
//!   2. `reset_all_sync_state_to_pending` (`queries.rs:7904`).
//! - **Keep table on:**
//!   1. `reset_local_sync_state` (`commands/sync.rs:1390`, callers `sync.rs:810, 1464`, `gdrive.rs:1472, 4374`).
//!   2. `run_repair_from_this_device` (`commands/sync.rs:1497`).
//!   3. `mark_scope_upgrade_required_in_tx` (`commands/sync.rs:1627`).
//!   4. Provider disconnect / reconnect (`gdrive_provider.rs:1285`).
//!   5. Surface push invalidation (`engine.rs:220`).
//!   6. Local-authoritative rebuild (`adopt_all_local_entries`, `queries.rs:7938`).
//!
//! The acks file (`outbox-acks.bin`) on Drive self-heals: every rewrite merges known
//! `created: true` statuses so imported entries are never resurrected as duplicates.
