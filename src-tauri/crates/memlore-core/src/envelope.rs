//! Key chain, envelope formats and cloud path rules of the Memlore sync protocol.
//!
//! # Status of this document
//!
//! This module holds this documentation (Phase 4, task 4.1) and, after it, the
//! seal/open API (task 4.3). Everything below describes WIRE-LEVEL
//! FACTS of the frozen v0.1.0 formats, traced from the shipping desktop code.
//! None of it may change: a newer app must read what v0.1.0 wrote and a v0.1.0
//! device must read what a newer app writes. Every claim cites `path:line` in
//! the repository at the time of writing (line numbers drift; the cited
//! function is the authority). Citations to `src-tauri/src/sync/metadata.rs` and
//! `src-tauri/src/sync/keyring_v2/types.rs` refer to the pre-move desktop paths:
//! those types now live in this crate's `metadata.rs` and `keyring_types.rs`.
//!
//! # The one key chain (read this first)
//!
//! Every encrypted cloud channel (entries, versions, embeddings, journals,
//! device-root `.bin` files, media, thumbnails) is sealed with AES-256-GCM under
//! the SAME per-epoch key, which is derived with TWO HKDF steps from the content
//! key of that epoch:
//!
//! 1. `content_key[e]` is a 32-byte key from the content-key list. Epoch 1 of a
//!    vault that has no `_content.json` is the master key itself
//!    (`src-tauri/crates/memlore-core/src/key_state.rs:97`,
//!    `src-tauri/src/commands/crypto.rs:2639`).
//! 2. `K1[e] = HKDF-SHA256(ikm = content_key[e], salt = none, info =
//!    "memlore-sync-envelope-v1", len = 32)`
//!    (`src-tauri/crates/memlore-core/src/encryption.rs:66`, `:81-87`).
//! 3. `K2[e] = HKDF-SHA256(ikm = K1[e], salt = none, info =
//!    "memlore-sync-envelope-v1", len = 32)`, the same function applied again.
//!    `K2[e]` is the AES-256-GCM key for every channel above.
//! 4. `fingerprint(K) = HMAC-SHA256(key = K, msg =
//!    "memlore-sync-v1-key-fingerprint")`, 32 bytes
//!    (`src-tauri/crates/memlore-core/src/encryption.rs:288-296`).
//! 5. AES-256-GCM output layout is `nonce(12) || ciphertext || tag(16)`, random
//!    nonce, no associated data
//!    (`src-tauri/crates/memlore-core/src/encryption.rs:121-132`, decrypt
//!    `:298-313`).
//!
//! Why two steps. `run_sync_now` copies `K1[latest]` out of the key state
//! (`src-tauri/src/commands/sync.rs:1138`) and hands it to the engine as "the
//! key". The engine wraps it in a throw-away key state with `set_key`
//! (`src-tauri/src/sync/engine.rs:619-623`, doc `:604-618`), so every
//! `with_sync_key` inside the engine derives once more and yields `K2[latest]`
//! (`src-tauri/crates/memlore-core/src/key_state.rs:97-110`, `:242-250`). The
//! ingest side gets a detached snapshot whose keys are PRE-derived once
//! (`K1[e]` for every epoch) so that its own internal derive reaches `K2[e]` too
//! (`src-tauri/crates/memlore-core/src/key_state.rs:408-432`, built at
//! `src-tauri/src/commands/sync.rs:1141`, passed to the engine at
//! `src-tauri/src/commands/sync.rs:1176`). The rotation re-encrypt code derives
//! the same depth (`src-tauri/src/sync/rotation/reencrypt.rs:119-127`). A single
//! HKDF is WRONG for every cloud channel. It is right only for the
//! `_content.json` fingerprint (see that section).
//!
//! # Channel table
//!
//! All paths are logical, `<device>/...`, relative to the generation folder (see
//! "Path namespace"). "Latest" means the highest epoch in the writer's list.
//!
//! | Channel | Path under `<device>/` | Outer framing | Envelope byte | AES key (write) | Fingerprint stored | Read key selection |
//! | --- | --- | --- | --- | --- | --- | --- |
//! | Entry | `entries/<entryId>.bin` | `XJS1` + bincode `SyncEntryPayload` | `0x01` on both inner blobs | `K2[latest]` | `fingerprint(K2[e])` in the frame | scan list by fingerprint |
//! | Version | `versions/<versionId>.bin` | `XJV1` + bincode `SyncVersionPayload` | `0x01` on both inner blobs | `K2[latest]` | `fingerprint(K2[e])` in the frame | scan list by fingerprint |
//! | Embedding batch | `embeddings/batch-<i>.bin` | `XJE1` + bincode `SyncEmbeddingChunkPayload` | `0x01` on the inner blob | `K2[latest]` | `fingerprint(K2[e])` in the frame | scan list by fingerprint |
//! | Journal | `journals/<journalId>.bin` | none, bare envelope | `0x01` | `K2[latest]` | none | try every epoch ascending |
//! | Device-root bins | `tags.bin`, `settings.bin`, `templates.bin` (also chats, memory, streak, locations, ai_audit, ai_reviews) | none, bare envelope | `0x01` | `K2[latest]` | none | try every epoch ascending |
//! | Media | `media/<mediaId>` | none, bare envelope | `0x02` on write, `0x01` or `0x02` on read | `K2[latest]` | none (epoch tag instead) | epoch tag for `0x02`, ascending trial for `0x01` |
//! | Thumbnail | `media/<mediaId>.thumb` | none, bare envelope | `0x02` on write, `0x01` or `0x02` on read | `K2[latest]` | none (epoch tag instead) | same as media |
//! | `metadata.json` | `metadata.json` | plain JSON | none, NOT encrypted | n/a | n/a | n/a |
//!
//! Two envelope shapes exist and must never be confused with the KEK blob
//! version byte (also `0x01`), which lives in a separate namespace
//! (`src-tauri/crates/memlore-core/src/encryption.rs:50-58`, `:450-453`):
//!
//! * `0x01` envelope: `[0x01] || nonce(12) || ciphertext || tag(16)`. No epoch.
//!   Writer: `encrypt_data_with_state`
//!   (`src-tauri/crates/memlore-core/src/encryption.rs:512-523`).
//! * `0x02` envelope: `[0x02] || epoch(4, little endian) || nonce(12) ||
//!   ciphertext || tag(16)`. Writer: `encrypt_data_with_state_epoch`
//!   (`src-tauri/crates/memlore-core/src/encryption.rs:538-553`). The 4 epoch
//!   bytes are NOT authenticated separately: a wrong epoch simply selects the
//!   wrong key and the GCM tag fails.
//! * Any other first byte, including `0x00`, is dead data and an error
//!   (`src-tauri/crates/memlore-core/src/encryption.rs:455-458`, `:554-605`).
//! * `0x02` shorter than `1 + 4 + 12 + 16` bytes is rejected before decrypt
//!   (`src-tauri/crates/memlore-core/src/encryption.rs:618-626`).
//! * A `0x02` epoch absent from the list fails with "unknown content-key epoch"
//!   and never falls back to another key
//!   (`src-tauri/crates/memlore-core/src/key_state.rs:281-306`).
//!
//! # Entries
//!
//! * Written by `push_single_entry` (`src-tauri/src/sync/engine.rs:3134`) to
//!   `<device>/entries/<entryId>.bin`
//!   (`src-tauri/src/sync/engine.rs:3275-3279`).
//! * Key: `ks = make_key_state(key_copy)` (`src-tauri/src/sync/engine.rs:3252`),
//!   so AES key `K2[latest]`. Fingerprint `fingerprint(K2[latest])`
//!   (`src-tauri/src/sync/engine.rs:3259-3261`).
//! * Frame: `SyncEntryPayload { schema_version: u16 = 1, key_fingerprint:
//!   [u8; 32], yjs_blob_ciphertext: Vec<u8>, metadata_ciphertext: Vec<u8> }`
//!   (`src-tauri/crates/memlore-core/src/entry_sync.rs:63-69`, version constant
//!   `:30`). Wire bytes: magic `XJS1` (`:35`), then bincode with fixed-width
//!   integers and a 32 MiB size limit (`:42`, `:91-95`, `:97-105`). The reader
//!   checks magic, then `schema_version == 1` with `!=` (`:120-144`); this check
//!   is a known landmine and `PAYLOAD_SCHEMA_VERSION` must not be bumped without
//!   the V2 struct and a `match` (`:26-29`, `:107-119`).
//! * `metadata_ciphertext` plaintext: `serde_json` of `EntryMetadata`
//!   (`src-tauri/src/sync/metadata.rs:677`, serialised at
//!   `src-tauri/src/sync/engine.rs:3244-3245`, sealed `:3262-3263`).
//!   `yjs_blob_ciphertext` plaintext: the raw Yjs full-state bytes, or empty when
//!   the entry has no body yet (`src-tauri/src/sync/engine.rs:3264-3271`).
//! * Both inner blobs carry the `0x01` envelope (`:3262-3271` uses
//!   `encrypt_data_with_state`).
//!
//! # Versions
//!
//! * `push_single_version` (`src-tauri/src/sync/engine.rs:3376-3404`) writes
//!   `<device>/versions/<versionId>.bin`
//!   (`src-tauri/src/sync/version_sync.rs:73-75`).
//! * Same chain as entries: `ks = make_key_state(key_copy)`
//!   (`src-tauri/src/sync/engine.rs:3332`), fingerprint
//!   `fingerprint(K2[latest])` (`:3393-3395`), both blobs sealed by
//!   `encrypt_version_bytes`, a thin wrapper over `encrypt_data_with_state`
//!   (`src-tauri/src/sync/version_sync.rs:124-130`), so `0x01`.
//! * Frame `SyncVersionPayload` has the same four fields as the entry frame
//!   (`src-tauri/src/sync/version_sync.rs:37-43`), magic `XJV1` (`:27`), schema
//!   version 1 (`:23`), `!=` check (`:110-116`). Plaintexts: Yjs snapshot bytes,
//!   and JSON `VersionMetadata` (`:60-69`).
//! * Reader: `ingest_version` (`src-tauri/src/sync/engine.rs:4142`): byte `0x01`
//!   guard (`:4153-4168`), fingerprint scan and decrypt of metadata
//!   (`:4170-4177`) and of Yjs (`:4249-4257`).
//!
//! # Embeddings
//!
//! * `push_embedding_chunks` (`src-tauri/src/sync/engine.rs:3581`) writes
//!   `<device>/embeddings/batch-<i>.bin`, `i` from 0 up
//!   (`src-tauri/src/sync/engine.rs:3639`). `ks = make_key_state(key_copy)`
//!   (`:3587`), fingerprint `fingerprint(K2[latest])` (`:3588-3590`), blob sealed
//!   by `encrypt_embedding_bytes` = `encrypt_data_with_state`, so `0x01`
//!   (`src-tauri/src/sync/embedding_sync.rs:193-199`).
//! * Frame `SyncEmbeddingChunkPayload { schema_version = 1, key_fingerprint,
//!   chunks_ciphertext }` (`src-tauri/src/sync/embedding_sync.rs:91-96`), magic
//!   `XJE1` (`:50`), version constant `:46`. Plaintext of the blob: bincode of
//!   `Vec<EmbeddingChunkVector>` (`:69`, `:131-135`).
//! * Reader: `pull_embedding_chunks` (`src-tauri/src/sync/engine.rs:3906`),
//!   `0x01` guard (`:3979-3995`), then `decrypt_embedding_bytes_by_fingerprint`
//!   (`src-tauri/src/sync/embedding_sync.rs:232-245`, call at
//!   `src-tauri/src/sync/engine.rs:3997`).
//!
//! # Media and thumbnails
//!
//! * Original: `<device>/media/<mediaId>`
//!   (`src-tauri/src/sync/engine.rs:831`). Thumbnail:
//!   `<device>/media/<mediaId>.thumb` (`src-tauri/src/sync/engine.rs:890`,
//!   `src-tauri/src/sync/media_sync.rs:90`). Thumbnails are JPEG
//!   (`src-tauri/src/utils/thumbnail.rs:59`).
//! * Both are sealed by `media_sync::encrypt_media_bytes`
//!   (`src-tauri/src/sync/engine.rs:843`, thumbnail `:892`), which calls
//!   `encrypt_data_with_state_epoch`
//!   (`src-tauri/src/sync/media_sync.rs:39-45`). That reads the engine's
//!   `key_state` argument, which is the pre-derived snapshot (`push_local`
//!   parameter, `src-tauri/src/sync/engine.rs:759-763`; `sync_now` passes
//!   `key_state_full` at `:5318`). `with_latest_sync_key` derives once more
//!   (`src-tauri/crates/memlore-core/src/key_state.rs:257-275`), so the AES key
//!   is `K2[latest]` and the envelope is `0x02` with the epoch of `latest`.
//!   Media is therefore ALSO double-HKDF, identical to entries. The test
//!   `snapshot_based_encrypt_decrypt_are_symmetric` pins this
//!   (`src-tauri/src/sync/media_sync.rs:186-215`); on-demand resolve uses the
//!   same snapshot (`src-tauri/src/commands/media.rs:1514`, `:1625`).
//! * Read: `decrypt_media_bytes` = `decrypt_data_with_state`
//!   (`src-tauri/src/sync/media_sync.rs:57-63`). BOTH envelopes are valid on
//!   read (`src-tauri/src/sync/media_sync.rs:16-24`,
//!   `src-tauri/crates/memlore-core/src/encryption.rs:607-633`):
//!   * `0x02`: the epoch tag selects `K2[epoch]`
//!     (`src-tauri/crates/memlore-core/src/key_state.rs:281-306`).
//!   * `0x01` (legacy, pre-epoch-tag): tries `K2[e]` for every epoch in
//!     ascending order and returns the first success
//!     (`src-tauri/crates/memlore-core/src/key_state.rs:351-370`).
//!
//! New writes, including thumbnails, are always `0x02`.
//!
//! # Journals
//!
//! `<device>/journals/<journalId>.bin`, plaintext `serde_json` of
//! `JournalPayload` (`src-tauri/src/sync/metadata.rs:190`), sealed with
//! `encrypt_data_with_state` under `make_key_state(key_copy)`
//! (`src-tauri/src/sync/engine.rs:2903-2911`), so `0x01` and `K2[latest]`, no
//! frame and no fingerprint. Read by `decrypt_data_with_state` (`:2983`), which
//! for `0x01` tries all epochs ascending. The folder name is fixed by
//! `FileKind::Journals` (`src-tauri/src/sync/provider.rs:49`).
//!
//! # Device-root bins (tags, settings, templates)
//!
//! * Files `<device>/tags.bin`, `<device>/settings.bin`,
//!   `<device>/templates.bin` (the same mechanism also writes chats, memory,
//!   streak, locations, ai_audit and ai_reviews; the authoritative stem list is
//!   `src-tauri/src/sync/engine.rs:346-356`).
//! * Writer: `push_hashed_surface` (`src-tauri/src/sync/engine.rs:1101-1126`):
//!   `ks = make_key_state(key_copy)` (`:1114`), `encrypt_data_with_state`
//!   (`:1115`), path `<device>/<surface>.bin` (`:1116`). So `0x01` under
//!   `K2[latest]`, no frame, no fingerprint.
//! * Plaintext: `serde_json` of `TagsPayload`, `SettingsPayload`,
//!   `TemplatesPayload` (`src-tauri/src/sync/metadata.rs:542`, `:555`, `:523`).
//! * Readers `pull_tags` (`src-tauri/src/sync/engine.rs:1334`, read `:1347`,
//!   decrypt `:1355`), `pull_settings` (`:1189`, read `:1205`, decrypt `:1215`),
//!   `pull_templates` (`:1452`, read `:1468`, decrypt `:1478`) all call
//!   `decrypt_data_with_state` on the pre-derived snapshot, so the epoch is found
//!   by ascending trial of `K2[e]`. A missing file is skipped, not an error.
//! * `FileKind::DeviceRoot` lists the files directly under the device folder
//!   (`src-tauri/src/sync/provider.rs:33-36`).
//!
//! # metadata.json
//!
//! * PLAINTEXT JSON, not encrypted, no envelope: `serde_json` of
//!   `DeviceMetadata` (`src-tauri/src/sync/metadata.rs:39`), written by
//!   `push_hashed_metadata_json` to `<device>/metadata.json`
//!   (`src-tauri/src/sync/engine.rs:1128-1143`, path `:1139`). Treat its
//!   contents as untrusted input.
//! * It is the manifest that drives pulls. A device folder WITHOUT
//!   `metadata.json` is skipped by every desktop pull
//!   (`src-tauri/src/sync/engine.rs:5136-5147`, NotFound arm `:5142`; the
//!   conditional path `:5189-5217`, NotFound arm `:5213-5217`).
//!
//! # _content.json and the three fingerprint depths
//!
//! Path: `.meta/keyring/_content.json`
//! (`src-tauri/src/sync/keyring_v2/io.rs:48`), plain JSON `ContentListV2 {
//! version = 2, latest_epoch, entries: [ContentEntryV2], created_at }` with
//! `ContentEntryV2 { epoch, wrapped_content, content_fingerprint }`
//! (`src-tauri/src/sync/keyring_v2/types.rs:226-261`, validation `:263-312`).
//!
//! * `wrapped_content`: 120 hex chars = `nonce(12) || ct(32) || tag(16)` =
//!   `AES-256-GCM(key = master, content_key)`, no KDF header and no epoch prefix
//!   (`src-tauri/src/sync/keyring_v2/types.rs:231-235`,
//!   `src-tauri/crates/memlore-core/src/encryption.rs:339-364`).
//! * `content_fingerprint`: 64 hex chars =
//!   `fingerprint(HKDF(content_key))`, ONE HKDF step, i.e. `fingerprint(K1[e])`
//!   (`src-tauri/src/sync/keyring_v2/types.rs:236-241`, verified at
//!   `src-tauri/src/commands/crypto.rs:2613-2624`, produced at
//!   `src-tauri/src/commands/sync.rs:2053-2054`).
//! * Entries must be strictly ascending by epoch and `latest_epoch` must equal
//!   the last epoch (`src-tauri/src/sync/keyring_v2/types.rs:295-312`).
//!
//! Three DIFFERENT fingerprint depths exist; they are not interchangeable:
//!
//! | Where | Formula | HKDF steps |
//! | --- | --- | --- |
//! | Entry, version, embedding frame `key_fingerprint` | `fingerprint(K2[e])` | 2 (`src-tauri/src/sync/engine.rs:3259-3261`) |
//! | `ContentEntryV2.content_fingerprint` | `fingerprint(K1[e])` | 1 (`src-tauri/src/commands/crypto.rs:2613`) |
//! | `KeyringMetaV2.master_fingerprint` | `fingerprint(master)` | 0 (`src-tauri/src/sync/keyring_v2/types.rs:67-69`, `src-tauri/src/commands/crypto.rs:2551`) |
//!
//! Onboarding handling of `_content.json` (`match kio::read_content`,
//! `src-tauri/src/commands/crypto.rs:2565-2676`). The reader maps a missing file
//! to `Ok(None)` and every other read error to `Err`
//! (`src-tauri/src/sync/keyring_v2/io.rs:372-387`, `:244-253`; `read_content`
//! also runs `validate`, so a malformed file is an `Err`):
//!
//! * PRESENT (`:2566`): empty `entries` is rejected as corrupt (`:2567-2576`).
//!   Each entry: hex-decode `wrapped_content`, unwrap with master (`:2596`),
//!   recompute `fingerprint(K1)` and compare with `content_fingerprint`; a
//!   mismatch is a hard error (`:2613-2624`). The list is then
//!   `{epoch -> content_key}` with `latest = latest_epoch`.
//! * ABSENT (`Ok(None)`, `:2639`): seed `{1 -> master}`, `latest = 1`. This is the
//!   pre-Phase-5 vault. It must be treated as a valid v1 = master vault
//!   (`:2639-2656`).
//! * TRANSIENT ERROR (`Err`, `:2657`): retry. NEVER treat as absent: falling back
//!   to v1 = master on a vault that has a random v1 content key would "succeed"
//!   with the wrong key and every decryption would then fail silently
//!   (`:2657-2674`).
//!
//! # Ingest across a key rotation
//!
//! A rotation appends a new epoch to the content-key list; older epochs stay in
//! the list so old data remains readable
//! (`src-tauri/crates/memlore-core/src/key_state.rs:4-27`). A file sealed before
//! the rotation, and not yet re-encrypted by the rotation job, keeps the
//! fingerprint (or epoch tag) of its old epoch. Ingest opens it as follows:
//!
//! 1. `ingest_entry` (`src-tauri/src/sync/engine.rs:5372`) receives
//!    `key_state_full`, the pre-derived all-epoch snapshot (`:5375`, built at
//!    `src-tauri/src/commands/sync.rs:1141`).
//! 2. It checks that both inner blobs start with `0x01`, otherwise
//!    `CrossModeReject` (`src-tauri/src/sync/engine.rs:5390-5405`). `0x02` is NOT
//!    valid for entries.
//! 3. `with_sync_key_for_fingerprint(payload.key_fingerprint, ..)` iterates the
//!    list ascending and computes `fingerprint(derive(snapshot[e])) =
//!    fingerprint(K2[e])` for each epoch; the first equal one wins and its `K2[e]`
//!    is handed to the closure
//!    (`src-tauri/crates/memlore-core/src/key_state.rs:312-338`). No match returns
//!    an error, never a guess.
//! 4. The closure strips byte 0 and runs raw `decrypt_data` with that key
//!    (`src-tauri/src/sync/engine.rs:5407-5426`). It deliberately does not call
//!    `decrypt_data_with_state`, which would use the latest key
//!    (`src-tauri/src/sync/engine.rs:5412-5417`). A fingerprint miss becomes
//!    `SyncError::Auth` ("re-pair required", `:5427-5433`).
//! 5. The Yjs blob is opened the same way with the same fingerprint
//!    (`src-tauri/src/sync/engine.rs:5515-5524`).
//!
//! Versions and embeddings use the identical sequence
//! (`src-tauri/src/sync/engine.rs:4170-4177`, `:4249-4257`,
//! `src-tauri/src/sync/embedding_sync.rs:232-245`). Journals, device-root bins
//! and legacy `0x01` media have no fingerprint and use ascending trial across all
//! epochs (`src-tauri/crates/memlore-core/src/key_state.rs:351-370`), and
//! `0x02` media uses its epoch tag. The master-key rotation job rewrites cloud
//! files under the new key and recomputes the fingerprint so devices keep
//! ingesting them (`src-tauri/src/sync/rotation/reencrypt.rs:320-352`).
//!
//! # Path namespace and read rules
//!
//! Logical paths used by the engine are `<device>/<subfolder>/<file>` or
//! `<device>/<file>`; the Drive provider accepts exactly 2 or 3 components, each
//! limited to `[A-Za-z0-9._-]`
//! (`src-tauri/src/sync/gdrive_provider.rs:1729-1758`). Device ids must be 4 to
//! 64 chars of `[A-Za-z0-9_-]` (`src-tauri/src/sync/safety.rs:18-23`).
//!
//! File layout per channel under a device folder:
//!
//! | Folder or file | Content | Citation |
//! | --- | --- | --- |
//! | `entries/<entryId>.bin` | entries | `src-tauri/src/sync/provider.rs:47`, `src-tauri/src/sync/engine.rs:3277` |
//! | `journals/<journalId>.bin` | journals | `src-tauri/src/sync/provider.rs:49`, `src-tauri/src/sync/engine.rs:2909` |
//! | `media/<mediaId>` and `media/<mediaId>.thumb` | media and thumbnails | `src-tauri/src/sync/provider.rs:48`, `src-tauri/src/sync/engine.rs:831`, `:890` |
//! | `versions/<versionId>.bin` | versions | `src-tauri/src/sync/provider.rs:50`, `src-tauri/src/sync/version_sync.rs:73-75` |
//! | `embeddings/batch-<i>.bin` | embedding batches | `src-tauri/src/sync/provider.rs:51`, `src-tauri/src/sync/engine.rs:3639` |
//! | `metadata.json` | plaintext manifest | `src-tauri/src/sync/engine.rs:1139` |
//! | `<surface>.bin` | device-root bins | `src-tauri/src/sync/engine.rs:1116` |
//!
//! ## Writes
//!
//! * Physical location of a write: `Memlore/generations/g-<N>/<device>/...`
//!   under the Drive `appDataFolder`, ALWAYS, even when `N = 0`
//!   (`src-tauri/src/sync/gdrive_provider.rs:2137-2147`,
//!   `ensure_generation_root` `:944-957`). `N` is the local recovery
//!   generation; the sentinel `u64::MAX` means 0
//!   (`src-tauri/src/sync/gdrive_provider.rs:561-573`).
//! * This holds because the production sync provider always enables the
//!   recovery fence (`src-tauri/src/commands/sync.rs:476-477`,
//!   `with_recovery_fence` `src-tauri/src/sync/gdrive_provider.rs:650-664`).
//!   With the fence off the "generation root" is the `Memlore` root itself
//!   (`src-tauri/src/sync/gdrive_provider.rs:912-917`, `:948-953`). Unfenced
//!   providers exist only in connect/onboarding flows
//!   (`src-tauri/src/commands/crypto.rs:2241`, `:2250`,
//!   `src-tauri/src/commands/gdrive.rs:744`); do not copy them for payloads.
//! * An existing file is updated only in the write namespace; a legacy flat file
//!   is never patched, a new gen file is created instead
//!   (`src-tauri/src/sync/gdrive_provider.rs:1171-1189`, `:2090-2118`).
//!
//! ## Reads: generation folder and legacy flat folder
//!
//! Desktop reads each device from BOTH `Memlore/generations/g-<N>/<device>/` and
//! the legacy flat `Memlore/<device>/`. Exact precedence:
//!
//! * Folder list per device, `resolve_device_folders_for_read`
//!   (`src-tauri/src/sync/gdrive_provider.rs:969-1020`): first the generation
//!   device folder if it exists, then the flat device folder if a true
//!   generation root exists (even when the generation device folder exists and
//!   is empty). If there is no `generations/g-<N>` folder at all, only the flat
//!   folder is used. The generation root lookup is
//!   `src-tauri/src/sync/gdrive_provider.rs:907-942`: `None` when `generations`
//!   or `g-<N>` is missing; with the fence off it is the root itself (`:912-917`).
//! * Single-file read (`read_file`, `resolve_file_id`
//!   `src-tauri/src/sync/gdrive_provider.rs:1966-1999`, `:1619-1646`): try the
//!   folders in order; the FIRST folder that contains the file wins. So the
//!   generation copy wins, and the flat copy is used only when the generation
//!   folder is missing or lacks that file. An empty generation slot does not hide
//!   flat files.
//! * Folder listing for subfolder kinds (`list_files`,
//!   `src-tauri/src/sync/gdrive_provider.rs:1945-1961`): union of basenames from
//!   both folders keyed by basename; on a name clash the generation entry wins.
//! * `FileKind::DeviceRoot` listing is generation-only, no flat fallback
//!   (`src-tauri/src/sync/gdrive_provider.rs:1925-1944`); it is used by the
//!   own-cloud reconcile (`src-tauri/src/sync/engine.rs:693-697`), not by
//!   pulls. Pulls read device-root files with `read_file`, which does dual-read.
//! * Device list (`list_devices`,
//!   `src-tauri/src/sync/gdrive_provider.rs:1876-1911`): sorted set union of
//!   folder names under the generation root and, when that root exists and is not
//!   the `Memlore` root, under the flat root
//!   (`list_device_names_under` `:1193-1241`). Names are filtered by
//!   `is_payload_device_folder_name`, which drops `generations` and anything that
//!   fails `is_safe_device_id` such as `.meta`
//!   (`src-tauri/src/sync/gdrive_provider.rs:1809-1811`).
//!
//! ## Duplicate-name folders
//!
//! Drive allows several sibling folders with the same name.
//!
//! * Only the `Memlore` ROOT folder is resolved deterministically: the query
//!   orders by `createdTime` and the first (earliest-created) wins
//!   (`find_canonical_root_folder`, query `orderBy=createdTime` at
//!   `src-tauri/src/sync/gdrive_provider.rs:1478-1481`, pick at `:1538`; doc
//!   comment `:1433-1439`; `ensure_root_folder_only` re-lists after create
//!   `:1246-1261`).
//! * Every other folder (`generations`, `g-<N>`, `<device>`, subfolders) uses
//!   `find_folder`, which has NO `orderBy` and takes the first item Drive returns
//!   (`src-tauri/src/sync/gdrive_provider.rs:795-856`, query `:801-810`, pick
//!   `:855`). File lookup under a folder is the same, first match
//!   (`src-tauri/src/sync/gdrive_provider.rs:1058-1098`). Desktop therefore does
//!   not reconcile duplicate non-root folders; a web client that wants a
//!   deterministic choice must add its own ordering and must not claim desktop
//!   parity for it.
//! * `reconcile_reserved_candidates`
//!   (`src-tauri/src/sync/gdrive_provider.rs:484-559`) is NOT folder
//!   reconciliation. It handles duplicate reserved AUTHORITY FILES only: sorts
//!   by `createdTime` then id (`:526-530`), requires every copy to have bytes
//!   identical to the expected bytes (`:531-554`, conflict is
//!   `SyncError::Auth` at `:549-552`) and deletes the later copies
//!   (`:555-557`).
//!
//! ## Peer folder without a manifest
//!
//! A device folder that has no `metadata.json` is skipped by every desktop pull
//! (`src-tauri/src/sync/engine.rs:5142`, `:5213-5217`).
//!
//! # Timestamps
//!
//! * All timestamps are Unix SECONDS as `i64`: `now_unix`
//!   (`src-tauri/src/utils/time.rs:7-14`), keyring fields
//!   (`src-tauri/src/sync/keyring_v2/types.rs:77-79`, `:259`), media upload
//!   stamping (`src-tauri/src/sync/engine.rs:864-867`, `as_secs()`).
//!   Never milliseconds.
//! * Skew bound: `MAX_CLOCK_SKEW_SECS = 86_400` (24 hours)
//!   (`src-tauri/src/sync/engine.rs:52-59`). A peer tombstone `updated_at` is
//!   clamped to `now + MAX_CLOCK_SKEW_SECS` before it is stored
//!   (`src-tauri/src/sync/engine.rs:4739`), and a media tombstone `deleted_at`
//!   beyond that bound is ignored (`src-tauri/src/sync/engine.rs:5680`). This
//!   is the desktop ingest tolerance. Any stricter web write refusal threshold
//!   is web policy, not a wire fact.

use std::collections::BTreeMap;

use zeroize::Zeroizing;

use crate::encryption::{
    decrypt_data, derive_sync_key, encrypt_data, key_fingerprint, parse_kek_params,
    unwrap_content_key, unwrap_key, wrap_key_with, KdfParams, KEY_SIZE, NONCE_SIZE, TAG_SIZE,
    VERSION_AES_GCM_V2_EPOCH,
};
use crate::entry_sync::{
    deserialize_payload, serialize_payload, SyncEntryPayload, PAYLOAD_SCHEMA_VERSION,
};
use crate::key_state::ContentKeyList;
use crate::keyring_types::ContentListV2;
use crate::recovery::{derive_recovery_key, validate_recovery_mnemonic};

/// `0x01` envelope byte (`encryption.rs` `VERSION_AES_GCM_V1`, private there).
const ENVELOPE_V1: u8 = 0x01;
/// Bytes of the little endian epoch tag in a `0x02` envelope.
const EPOCH_SIZE: usize = 4;
/// Magic of the entry frame (`entry_sync.rs` `PAYLOAD_MAGIC`, private there). A
/// test pins it against `serialize_payload`.
const ENTRY_MAGIC: [u8; 4] = *b"XJS1";

/// Failure modes of the envelope API. Variants are distinct so a caller can
/// tell a wrong key from a damaged or foreign file.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum EnvelopeError {
    /// The envelope has no version byte at all.
    #[error("envelope is empty")]
    Empty,
    /// The buffer is shorter than the minimum for its format.
    #[error("buffer too short")]
    ShortBuffer,
    /// An entry frame does not start with `XJS1`.
    #[error("invalid entry frame magic")]
    BadMagic,
    /// An entry frame carries a schema version this build cannot read.
    #[error("unsupported entry frame schema version {0}")]
    UnsupportedSchemaVersion(u16),
    /// Envelope byte other than the ones valid for the channel.
    #[error("unknown envelope version: {0:#04x}")]
    UnknownVersion(u8),
    /// A `0x02` envelope names an epoch absent from the content-key list.
    #[error("unknown content-key epoch {0}")]
    UnknownEpoch(u32),
    /// AES-GCM authentication failed under every candidate key (wrong key or
    /// damaged data).
    #[error("wrong key or corrupted data")]
    WrongKey,
    /// The entry frame fingerprint matches no epoch of the content-key list.
    #[error("key fingerprint matches no content key in the list")]
    FingerprintMismatch,
    /// A `_content.json` entry unwrapped, but its stored fingerprint differs.
    #[error("content key fingerprint mismatch at epoch {epoch}")]
    ContentFingerprintMismatch { epoch: u32 },
    /// `fingerprint(master)` differs from the expected value.
    #[error("master key fingerprint mismatch")]
    MasterFingerprintMismatch,
    /// The recovery phrase is not a valid 24-word BIP39 phrase.
    #[error("invalid recovery phrase: {0}")]
    InvalidRecoveryPhrase(String),
    /// `_content.json` is not valid JSON, fails validation, or has no entries.
    #[error("invalid content list: {0}")]
    InvalidContentList(String),
    /// Hex, frame or KEK-header damage that is not a key problem.
    #[error("malformed input: {0}")]
    Malformed(String),
    /// A primitive failed while sealing (encryption or serialization).
    #[error("crypto failure: {0}")]
    Crypto(String),
}

/// Plaintext of one opened entry file.
#[derive(Debug, PartialEq, Eq)]
pub struct OpenedEntry {
    /// `serde_json` of `EntryMetadata` (parse with `metadata::EntryMetadata`).
    pub metadata_json: Vec<u8>,
    /// Raw Yjs full-state bytes, empty when the entry has no body yet.
    pub yjs: Vec<u8>,
}

/// `K2[e]`: the AES key of every cloud channel for the content key `content`.
/// Two HKDF steps (see "The one key chain").
fn envelope_key(content: &[u8; KEY_SIZE]) -> Zeroizing<[u8; KEY_SIZE]> {
    let k1 = derive_sync_key(content);
    derive_sync_key(&k1)
}

/// `K2` and epoch of the latest content key (`key_state.rs`
/// `with_latest_sync_key` applied to the engine's pre-derived snapshot).
fn latest_envelope_key(
    list: &ContentKeyList,
) -> Result<(u32, Zeroizing<[u8; KEY_SIZE]>), EnvelopeError> {
    let content = list
        .keys
        .get(&list.latest)
        .ok_or(EnvelopeError::UnknownEpoch(list.latest))?;
    Ok((list.latest, envelope_key(content)))
}

fn seal_v1(key: &[u8; KEY_SIZE], plaintext: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let inner = encrypt_data(key, plaintext).map_err(EnvelopeError::Crypto)?;
    let mut out = Vec::with_capacity(1 + inner.len());
    out.push(ENVELOPE_V1);
    out.extend_from_slice(&inner);
    Ok(out)
}

/// Strip the `0x01` byte of an entry inner blob and decrypt it with `key`
/// (`engine.rs` `ingest_entry`, closure of `with_sync_key_for_fingerprint`).
fn open_v1_with(key: &[u8; KEY_SIZE], blob: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let inner = blob.get(1..).ok_or(EnvelopeError::Empty)?;
    if inner.len() < NONCE_SIZE + TAG_SIZE {
        return Err(EnvelopeError::ShortBuffer);
    }
    decrypt_data(key, inner).map_err(|_| EnvelopeError::WrongKey)
}

/// Seal one entry file `<device>/entries/<entryId>.bin`
/// (`engine.rs` `push_single_entry`, `:3252-3279`).
///
/// Both inner blobs are `0x01` envelopes under `K2[latest]`; the frame carries
/// `fingerprint(K2[latest])`. An entry without a body passes an empty `yjs`,
/// which is still sealed (`engine.rs:3264-3271`). `metadata_json` is the
/// `serde_json` of `EntryMetadata`.
pub fn seal_entry(
    list: &ContentKeyList,
    metadata_json: &[u8],
    yjs: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let (_, key) = latest_envelope_key(list)?;
    let fp = key_fingerprint(&key);
    let meta_ct = seal_v1(&key, metadata_json)?;
    let yjs_ct = seal_v1(&key, yjs)?;
    let payload = SyncEntryPayload::new(fp, yjs_ct, meta_ct);
    serialize_payload(&payload).map_err(|e| EnvelopeError::Crypto(e.to_string()))
}

/// Open one entry file (`engine.rs` `ingest_entry`, `:5390-5426`, `:5515-5524`).
///
/// Checks the `XJS1` magic and schema version, requires `0x01` on both inner
/// blobs (`0x02` is NOT valid for entries), selects the epoch whose
/// `fingerprint(K2[e])` equals the frame fingerprint (ascending scan, no
/// guessing) and decrypts both blobs with that key.
pub fn open_entry(list: &ContentKeyList, bytes: &[u8]) -> Result<OpenedEntry, EnvelopeError> {
    if bytes.len() < ENTRY_MAGIC.len() {
        return Err(EnvelopeError::ShortBuffer);
    }
    if bytes[..ENTRY_MAGIC.len()] != ENTRY_MAGIC {
        return Err(EnvelopeError::BadMagic);
    }
    // schema_version is the first bincode field, fixed width little endian.
    let body = &bytes[ENTRY_MAGIC.len()..];
    let Some(version) = body.get(..2) else {
        return Err(EnvelopeError::ShortBuffer);
    };
    let version = u16::from_le_bytes([version[0], version[1]]);
    if version != PAYLOAD_SCHEMA_VERSION {
        return Err(EnvelopeError::UnsupportedSchemaVersion(version));
    }
    let payload =
        deserialize_payload(bytes).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;

    let yjs_first = payload.yjs_blob_ciphertext.first().copied();
    let meta_first = payload.metadata_ciphertext.first().copied();
    let (Some(y), Some(m)) = (yjs_first, meta_first) else {
        return Err(EnvelopeError::Empty);
    };
    for b in [y, m] {
        if b != ENVELOPE_V1 {
            return Err(EnvelopeError::UnknownVersion(b));
        }
    }

    for content in list.keys.values() {
        let key = envelope_key(content);
        if key_fingerprint(&key) == payload.key_fingerprint {
            return Ok(OpenedEntry {
                metadata_json: open_v1_with(&key, &payload.metadata_ciphertext)?,
                yjs: open_v1_with(&key, &payload.yjs_blob_ciphertext)?,
            });
        }
    }
    Err(EnvelopeError::FingerprintMismatch)
}

/// Seal media bytes for `<device>/media/<mediaId>`
/// (`media_sync.rs:39-45` `encrypt_media_bytes`): `0x02 || epoch(4 LE) || nonce
/// || ct || tag` under `K2[latest]`, epoch of `latest`.
pub fn seal_media(list: &ContentKeyList, plaintext: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let (epoch, key) = latest_envelope_key(list)?;
    let inner = encrypt_data(&key, plaintext).map_err(EnvelopeError::Crypto)?;
    let mut out = Vec::with_capacity(1 + EPOCH_SIZE + inner.len());
    out.push(VERSION_AES_GCM_V2_EPOCH);
    out.extend_from_slice(&epoch.to_le_bytes());
    out.extend_from_slice(&inner);
    Ok(out)
}

/// Seal a JPEG thumbnail for `<device>/media/<mediaId>.thumb`. Desktop seals it
/// with the same function as the original (`engine.rs:892`), so this is
/// byte-format identical to [`seal_media`]: always `0x02`.
pub fn seal_thumb(list: &ContentKeyList, jpeg: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    seal_media(list, jpeg)
}

/// Open a bare envelope (`decrypt_data_with_state`, `encryption.rs:607-633`).
///
/// * `0x01`: no epoch, try `K2[e]` for every epoch ascending
///   (`key_state.rs:351-370`).
/// * `0x02`: the epoch tag selects `K2[epoch]`; an absent epoch is an error and
///   never falls back to another key (`key_state.rs:281-306`).
fn open_bare(list: &ContentKeyList, envelope: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let (version, rest) = envelope.split_first().ok_or(EnvelopeError::Empty)?;
    match *version {
        ENVELOPE_V1 => {
            if rest.len() < NONCE_SIZE + TAG_SIZE {
                return Err(EnvelopeError::ShortBuffer);
            }
            // BTreeMap iterates ascending.
            for content in list.keys.values() {
                if let Ok(plain) = decrypt_data(&envelope_key(content), rest) {
                    return Ok(plain);
                }
            }
            Err(EnvelopeError::WrongKey)
        }
        VERSION_AES_GCM_V2_EPOCH => {
            if rest.len() < EPOCH_SIZE + NONCE_SIZE + TAG_SIZE {
                return Err(EnvelopeError::ShortBuffer);
            }
            let epoch = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
            let content = list
                .keys
                .get(&epoch)
                .ok_or(EnvelopeError::UnknownEpoch(epoch))?;
            decrypt_data(&envelope_key(content), &rest[EPOCH_SIZE..])
                .map_err(|_| EnvelopeError::WrongKey)
        }
        other => Err(EnvelopeError::UnknownVersion(other)),
    }
}

/// Open media or a thumbnail. Accepts the legacy `0x01` and the epoch `0x02`
/// envelope (`media_sync.rs:16-24`, `:57-63`).
pub fn open_media(list: &ContentKeyList, envelope: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    open_bare(list, envelope)
}

/// Open a device-root bin (`tags.bin`, `templates.bin`, `settings.bin`)
/// (`engine.rs:1355`, `:1215`, `:1478`). Read-only; returns the `serde_json`
/// plaintext of `TagsPayload` / `TemplatesPayload` / `SettingsPayload`.
pub fn open_device_bin(list: &ContentKeyList, envelope: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    open_bare(list, envelope)
}

/// Unwrap the master key from the recovery slot: `wrapped_master_hex` is
/// `AES-GCM(recovery_key, master)` with `recovery_key` the HKDF of the BIP39
/// phrase, raw AES with no Argon2 (`commands/crypto.rs:2408-2413`,
/// `unwrap_master_with_recovery_key` `:3141-3158`).
pub fn unwrap_master_with_recovery(
    phrase: &str,
    wrapped_master_hex: &str,
) -> Result<Zeroizing<[u8; KEY_SIZE]>, EnvelopeError> {
    let mnemonic =
        validate_recovery_mnemonic(phrase).map_err(EnvelopeError::InvalidRecoveryPhrase)?;
    let recovery_key = derive_recovery_key(&mnemonic);
    let blob = hex::decode(wrapped_master_hex)
        .map_err(|e| EnvelopeError::Malformed(format!("wrapped master hex: {e}")))?;
    let plain = decrypt_data(&recovery_key, &blob).map_err(|_| EnvelopeError::WrongKey)?;
    if plain.len() != KEY_SIZE {
        return Err(EnvelopeError::Malformed(format!(
            "unwrapped master has wrong size: {}",
            plain.len()
        )));
    }
    let mut master = Zeroizing::new([0u8; KEY_SIZE]);
    master.copy_from_slice(&plain);
    Ok(master)
}

/// Check `hex(fingerprint(master)) == KeyringMetaV2.master_fingerprint`, zero
/// HKDF steps and an exact string comparison like desktop
/// (`commands/crypto.rs:2551`, `:2429-2436`).
pub fn verify_master_fingerprint(
    master: &[u8; KEY_SIZE],
    expected_hex: &str,
) -> Result<(), EnvelopeError> {
    if hex::encode(key_fingerprint(master)) == expected_hex {
        Ok(())
    } else {
        Err(EnvelopeError::MasterFingerprintMismatch)
    }
}

/// Build the content-key list from `_content.json` text and the master key
/// (`commands/crypto.rs:2566-2626`). Validates the file, rejects empty
/// `entries`, unwraps every epoch with `master` and checks
/// `fingerprint(K1[e]) == content_fingerprint` (one HKDF step) for each.
///
/// The ABSENT-file case (`{1 -> master}`) is the caller's decision and is not
/// handled here: never call this to emulate it, and never treat a read error as
/// absent. `db_key` is a zero placeholder (no SQLCipher on the web, same as
/// `snapshot_for_engine`); `master` is stored for the caller's use.
pub fn load_content_list(
    content_json: &str,
    master: &[u8; KEY_SIZE],
) -> Result<ContentKeyList, EnvelopeError> {
    let list: ContentListV2 = serde_json::from_str(content_json)
        .map_err(|e| EnvelopeError::InvalidContentList(e.to_string()))?;
    list.validate().map_err(EnvelopeError::InvalidContentList)?;
    if list.entries.is_empty() {
        return Err(EnvelopeError::InvalidContentList("no entries".to_string()));
    }
    let mut keys = BTreeMap::new();
    for entry in &list.entries {
        let blob = hex::decode(&entry.wrapped_content).map_err(|e| {
            EnvelopeError::Malformed(format!("epoch {} wrapped_content hex: {e}", entry.epoch))
        })?;
        let key = unwrap_content_key(master, &blob).map_err(|_| EnvelopeError::WrongKey)?;
        let fp = hex::encode(key_fingerprint(&derive_sync_key(&key)));
        if fp != entry.content_fingerprint {
            return Err(EnvelopeError::ContentFingerprintMismatch { epoch: entry.epoch });
        }
        keys.insert(entry.epoch, key);
    }
    Ok(ContentKeyList {
        keys,
        latest: list.latest_epoch,
        db_key: Zeroizing::new([0u8; KEY_SIZE]),
        master: Zeroizing::new(*master),
    })
}

/// Wrap the master key under a password for local storage: the existing
/// self-describing 67-byte KEK blob as 134 hex chars, `KdfParams::FAST`
/// (`encryption.rs:144-186`). `kek_salt` comes from
/// `encryption::generate_encryption_salt` and must be stored by the caller.
pub fn wrap_master_local(
    master: &[u8; KEY_SIZE],
    password: &str,
    kek_salt: &[u8],
) -> Result<String, EnvelopeError> {
    wrap_key_with(master, password, kek_salt, KdfParams::FAST).map_err(EnvelopeError::Crypto)
}

/// Inverse of [`wrap_master_local`] (`encryption.rs:242-267`). A damaged or
/// non-FAST header is `Malformed`; a failed AES-GCM tag is `WrongKey`.
pub fn unlock_local(
    wrapped_hex: &str,
    password: &str,
    kek_salt: &[u8],
) -> Result<Zeroizing<[u8; KEY_SIZE]>, EnvelopeError> {
    let blob = hex::decode(wrapped_hex)
        .map_err(|e| EnvelopeError::Malformed(format!("wrapped key hex: {e}")))?;
    parse_kek_params(&blob).map_err(EnvelopeError::Malformed)?;
    unwrap_key(wrapped_hex, password, kek_salt).map_err(|_| EnvelopeError::WrongKey)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::{
        decrypt_data_with_state, encrypt_data_with_state, encrypt_data_with_state_epoch,
        generate_encryption_salt, wrap_content_key,
    };
    use crate::key_state::EncryptionKeyState;

    fn key(b: u8) -> Zeroizing<[u8; 32]> {
        Zeroizing::new([b; 32])
    }

    fn list_of(epochs: &[(u32, u8)], latest: u32) -> ContentKeyList {
        ContentKeyList {
            keys: epochs.iter().map(|(e, b)| (*e, key(*b))).collect(),
            latest,
            db_key: key(0),
            master: key(9),
        }
    }

    /// Desktop engine view of `list`: pre-derived snapshot, like
    /// `snapshot_for_engine` / `make_key_state`.
    fn engine_state(list: &ContentKeyList) -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        let keys = list.keys.iter().map(|(e, k)| (*e, key(k[0]))).collect();
        ks.set_content_state(keys, list.latest, key(0), key(9))
            .unwrap();
        ks.snapshot_for_engine().unwrap()
    }

    fn one() -> ContentKeyList {
        list_of(&[(1, 1)], 1)
    }

    const META: &[u8] = br#"{"entry_id":"e1"}"#;

    // ---- entries ----

    #[test]
    fn entry_magic_matches_core_codec() {
        let p = SyncEntryPayload::new([0; 32], vec![], vec![]);
        assert_eq!(serialize_payload(&p).unwrap()[..4], ENTRY_MAGIC);
    }

    #[test]
    fn entry_round_trip_including_empty_yjs() {
        let l = one();
        let opened = open_entry(&l, &seal_entry(&l, META, b"yjs").unwrap()).unwrap();
        assert_eq!(opened.metadata_json, META);
        assert_eq!(opened.yjs, b"yjs");
        let empty = open_entry(&l, &seal_entry(&l, META, b"").unwrap()).unwrap();
        assert!(empty.yjs.is_empty());
    }

    #[test]
    fn entry_matches_desktop_engine_bytes_both_ways() {
        let l = list_of(&[(1, 1), (2, 2)], 2);
        let ks = engine_state(&l);
        // Desktop-style seal (push_single_entry) opens with open_entry.
        let fp = ks.with_sync_key(|k| Ok(key_fingerprint(k))).unwrap();
        let payload = SyncEntryPayload::new(
            fp,
            encrypt_data_with_state(b"yjs", &ks).unwrap(),
            encrypt_data_with_state(META, &ks).unwrap(),
        );
        let opened = open_entry(&l, &serialize_payload(&payload).unwrap()).unwrap();
        assert_eq!(
            (opened.metadata_json.as_slice(), opened.yjs.as_slice()),
            (META, &b"yjs"[..])
        );
        // seal_entry output is accepted by the desktop ingest closure.
        let sealed = deserialize_payload(&seal_entry(&l, META, b"yjs").unwrap()).unwrap();
        assert_eq!(sealed.key_fingerprint, fp);
        assert_eq!(sealed.metadata_ciphertext[0], 0x01);
        assert_eq!(
            decrypt_data_with_state(&sealed.metadata_ciphertext, &ks).unwrap(),
            META
        );
    }

    #[test]
    fn entry_sealed_before_rotation_opens_with_older_epoch() {
        let old = list_of(&[(1, 1)], 1);
        let sealed = seal_entry(&old, META, b"y").unwrap();
        let rotated = list_of(&[(1, 1), (2, 2)], 2);
        assert_eq!(open_entry(&rotated, &sealed).unwrap().yjs, b"y");
    }

    #[test]
    fn entry_wrong_key_is_fingerprint_mismatch() {
        let sealed = seal_entry(&one(), META, b"y").unwrap();
        let other = list_of(&[(1, 7)], 1);
        assert_eq!(
            open_entry(&other, &sealed),
            Err(EnvelopeError::FingerprintMismatch)
        );
    }

    #[test]
    fn entry_tampered_ciphertext_is_wrong_key() {
        let l = one();
        let mut p = deserialize_payload(&seal_entry(&l, META, b"y").unwrap()).unwrap();
        let last = p.metadata_ciphertext.len() - 1;
        p.metadata_ciphertext[last] ^= 1;
        assert_eq!(
            open_entry(&l, &serialize_payload(&p).unwrap()),
            Err(EnvelopeError::WrongKey)
        );
    }

    #[test]
    fn entry_short_buffer_wrong_magic_and_version() {
        let l = one();
        assert_eq!(open_entry(&l, b"XJ"), Err(EnvelopeError::ShortBuffer));
        assert_eq!(open_entry(&l, b"XJS1"), Err(EnvelopeError::ShortBuffer));
        assert_eq!(
            open_entry(&l, b"NOPE\x01\x00"),
            Err(EnvelopeError::BadMagic)
        );
        let mut p = SyncEntryPayload::new([0; 32], vec![1], vec![1]);
        p.schema_version = 2;
        assert_eq!(
            open_entry(&l, &serialize_payload(&p).unwrap()),
            Err(EnvelopeError::UnsupportedSchemaVersion(2))
        );
    }

    #[test]
    fn entry_rejects_epoch_envelope_and_empty_blobs() {
        let l = one();
        let (_, k) = latest_envelope_key(&l).unwrap();
        let fp = key_fingerprint(&k);
        let epoch_blob = seal_media(&l, b"x").unwrap();
        let p = SyncEntryPayload::new(fp, epoch_blob.clone(), epoch_blob);
        assert_eq!(
            open_entry(&l, &serialize_payload(&p).unwrap()),
            Err(EnvelopeError::UnknownVersion(0x02))
        );
        let p = SyncEntryPayload::new(fp, vec![], vec![]);
        assert_eq!(
            open_entry(&l, &serialize_payload(&p).unwrap()),
            Err(EnvelopeError::Empty)
        );
    }

    // ---- media, thumbnails, device bins ----

    #[test]
    fn media_round_trip_and_epoch_tag() {
        let l = list_of(&[(1, 1), (2, 2)], 2);
        let sealed = seal_media(&l, b"bytes").unwrap();
        assert_eq!(sealed[0], 0x02);
        assert_eq!(sealed[1..5], 2u32.to_le_bytes());
        assert_eq!(open_media(&l, &sealed).unwrap(), b"bytes");
    }

    #[test]
    fn thumb_is_always_epoch_envelope() {
        let l = one();
        let sealed = seal_thumb(&l, b"jpeg").unwrap();
        assert_eq!(sealed[0], 0x02);
        assert_eq!(open_media(&l, &sealed).unwrap(), b"jpeg");
    }

    #[test]
    fn media_matches_desktop_engine_bytes_for_both_envelopes() {
        let l = list_of(&[(1, 1), (2, 2)], 2);
        let ks = engine_state(&l);
        let v2 = encrypt_data_with_state_epoch(b"m", &ks).unwrap();
        assert_eq!(v2[0], 0x02);
        assert_eq!(open_media(&l, &v2).unwrap(), b"m");
        let v1 = encrypt_data_with_state(b"m", &ks).unwrap();
        assert_eq!(v1[0], 0x01);
        assert_eq!(open_media(&l, &v1).unwrap(), b"m");
        assert_eq!(
            decrypt_data_with_state(&seal_media(&l, b"m").unwrap(), &ks).unwrap(),
            b"m"
        );
    }

    #[test]
    fn media_legacy_v1_from_old_epoch_opens_after_rotation() {
        let old = list_of(&[(1, 1)], 1);
        let v1 = encrypt_data_with_state(b"m", &engine_state(&old)).unwrap();
        let rotated = list_of(&[(1, 1), (2, 2)], 2);
        assert_eq!(open_media(&rotated, &v1).unwrap(), b"m");
    }

    #[test]
    fn media_error_cases() {
        let l = one();
        let sealed = seal_media(&l, b"m").unwrap();
        assert_eq!(
            open_media(&list_of(&[(1, 7)], 1), &sealed),
            Err(EnvelopeError::WrongKey)
        );
        assert_eq!(open_media(&l, &[]), Err(EnvelopeError::Empty));
        assert_eq!(
            open_media(&l, &sealed[..20]),
            Err(EnvelopeError::ShortBuffer)
        );
        assert_eq!(
            open_media(&l, &[0x01, 1, 2]),
            Err(EnvelopeError::ShortBuffer)
        );
        assert_eq!(
            open_media(&l, &[0x00; 40]),
            Err(EnvelopeError::UnknownVersion(0))
        );
        assert_eq!(
            open_media(&l, &[0x03; 40]),
            Err(EnvelopeError::UnknownVersion(3))
        );
        let other_epoch = list_of(&[(5, 1)], 5);
        assert_eq!(
            open_media(&other_epoch, &sealed),
            Err(EnvelopeError::UnknownEpoch(1))
        );
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(open_media(&l, &bad), Err(EnvelopeError::WrongKey));
    }

    #[test]
    fn device_bin_opens_desktop_v1_envelope() {
        let l = list_of(&[(1, 1), (2, 2)], 2);
        let bin = encrypt_data_with_state(br#"{"tags":[]}"#, &engine_state(&l)).unwrap();
        assert_eq!(open_device_bin(&l, &bin).unwrap(), br#"{"tags":[]}"#);
        assert_eq!(
            open_device_bin(&list_of(&[(1, 8)], 1), &bin),
            Err(EnvelopeError::WrongKey)
        );
    }

    // ---- recovery, fingerprints ----

    #[test]
    fn recovery_unwrap_round_trip_and_errors() {
        let phrase = crate::recovery::generate_recovery_mnemonic().unwrap();
        let rk = derive_recovery_key(&validate_recovery_mnemonic(&phrase).unwrap());
        let master = [5u8; 32];
        let wrapped = hex::encode(encrypt_data(&rk, &master).unwrap());
        assert_eq!(
            *unwrap_master_with_recovery(&phrase, &wrapped).unwrap(),
            master
        );

        let other = crate::recovery::generate_recovery_mnemonic().unwrap();
        assert_eq!(
            unwrap_master_with_recovery(&other, &wrapped).unwrap_err(),
            EnvelopeError::WrongKey
        );
        assert!(matches!(
            unwrap_master_with_recovery("not a phrase", &wrapped),
            Err(EnvelopeError::InvalidRecoveryPhrase(_))
        ));
        assert!(matches!(
            unwrap_master_with_recovery(&phrase, "zz"),
            Err(EnvelopeError::Malformed(_))
        ));
    }

    #[test]
    fn master_fingerprint_verifies_zero_hkdf_depth() {
        let m = [3u8; 32];
        let fp = hex::encode(key_fingerprint(&m));
        assert_eq!(verify_master_fingerprint(&m, &fp), Ok(()));
        assert_eq!(
            verify_master_fingerprint(&[4u8; 32], &fp),
            Err(EnvelopeError::MasterFingerprintMismatch)
        );
    }

    // ---- _content.json ----

    fn content_json(master: &[u8; 32], epochs: &[(u32, u8)], bad_fp_at: Option<u32>) -> String {
        let entries = epochs
            .iter()
            .map(|(e, b)| {
                let ck = [*b; 32];
                let mut fp = hex::encode(key_fingerprint(&derive_sync_key(&ck)));
                if bad_fp_at == Some(*e) {
                    fp = hex::encode(key_fingerprint(&ck)); // wrong depth: 0 HKDF steps
                }
                crate::keyring_types::ContentEntryV2 {
                    epoch: *e,
                    wrapped_content: hex::encode(wrap_content_key(master, &ck).unwrap()),
                    content_fingerprint: fp,
                }
            })
            .collect::<Vec<_>>();
        serde_json::to_string(&ContentListV2 {
            version: 2,
            latest_epoch: epochs.last().map(|(e, _)| *e).unwrap_or(0),
            entries,
            created_at: 10,
        })
        .unwrap()
    }

    #[test]
    fn content_list_two_epochs_loads_and_seals_double_hkdf() {
        let master = [9u8; 32];
        let l =
            load_content_list(&content_json(&master, &[(1, 1), (2, 2)], None), &master).unwrap();
        assert_eq!(l.latest, 2);
        assert_eq!(l.keys.len(), 2);
        assert_eq!(*l.keys[&1], [1u8; 32]);
        let sealed = seal_entry(&l, META, b"y").unwrap();
        assert_eq!(open_entry(&l, &sealed).unwrap().yjs, b"y");
    }

    #[test]
    fn content_list_error_cases() {
        let master = [9u8; 32];
        assert_eq!(
            load_content_list(&content_json(&master, &[(1, 1), (2, 2)], Some(2)), &master)
                .err()
                .unwrap(),
            EnvelopeError::ContentFingerprintMismatch { epoch: 2 }
        );
        assert_eq!(
            load_content_list(&content_json(&master, &[(1, 1)], None), &[8u8; 32])
                .err()
                .unwrap(),
            EnvelopeError::WrongKey
        );
        assert!(matches!(
            load_content_list("{", &master),
            Err(EnvelopeError::InvalidContentList(_))
        ));
        assert!(matches!(
            load_content_list(&content_json(&master, &[], None), &master),
            Err(EnvelopeError::InvalidContentList(_))
        ));
    }

    // ---- local wrap ----

    #[test]
    fn local_wrap_round_trip_and_wrong_password() {
        let master = [6u8; 32];
        let salt = generate_encryption_salt();
        let wrapped = wrap_master_local(&master, "12345678", &salt).unwrap();
        assert_eq!(wrapped.len(), 134);
        assert_eq!(*unlock_local(&wrapped, "12345678", &salt).unwrap(), master);
        assert_eq!(
            unlock_local(&wrapped, "87654321", &salt).unwrap_err(),
            EnvelopeError::WrongKey
        );
        assert!(matches!(
            unlock_local("zz", "x", &salt),
            Err(EnvelopeError::Malformed(_))
        ));
        assert!(matches!(
            unlock_local(&hex::encode([0u8; 60]), "x", &salt),
            Err(EnvelopeError::Malformed(_))
        ));
    }

    // ---- golden: sealed by WASM, opened natively ----

    fn b64_decode(text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for c in text.bytes().filter(|c| *c != b'=') {
            let v = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => panic!("bad base64 byte {c}"),
            };
            acc = (acc << 6) | u32::from(v);
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        out
    }

    /// Content keys of the frozen desktop vault, loaded exactly like
    /// `golden_desktop_fixture_decodes` does.
    fn desktop_vault_list() -> ContentKeyList {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
        let vault: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}desktop-vault.v1.json")).unwrap(),
        )
        .unwrap();
        let file = |path: &str| -> String {
            String::from_utf8(b64_decode(vault["files"][path].as_str().unwrap())).unwrap()
        };
        let recovery: serde_json::Value =
            serde_json::from_str(&file(".meta/keyring/_recovery.json")).unwrap();
        let meta: serde_json::Value =
            serde_json::from_str(&file(".meta/keyring/_meta.json")).unwrap();
        let master = unwrap_master_with_recovery(
            vault["recovery_phrase"].as_str().unwrap(),
            recovery["wrapped_master"].as_str().unwrap(),
        )
        .unwrap();
        verify_master_fingerprint(&master, meta["master_fingerprint"].as_str().unwrap()).unwrap();
        load_content_list(&file(".meta/keyring/_content.json"), &master).unwrap()
    }

    fn web_fixture() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/web-envelopes.v1.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn fixture_bytes(fixture: &serde_json::Value, section: &str, field: &str) -> Vec<u8> {
        b64_decode(fixture[section][field].as_str().unwrap())
    }

    /// Same keys under shifted epoch numbers: no epoch of the envelope exists.
    fn shifted_epochs(list: &ContentKeyList) -> ContentKeyList {
        ContentKeyList {
            keys: list
                .keys
                .iter()
                .map(|(e, k)| (e + 100, key(k[0])))
                .collect(),
            latest: list.latest + 100,
            db_key: key(0),
            master: key(9),
        }
    }

    fn flip_last_byte(bytes: &[u8]) -> Vec<u8> {
        let mut bad = bytes.to_vec();
        *bad.last_mut().unwrap() ^= 0x01;
        bad
    }

    #[test]
    fn golden_web_envelopes_open_entry() {
        let list = desktop_vault_list();
        let f = web_fixture();
        let env = fixture_bytes(&f, "entry", "envelope_b64");
        assert_eq!(&env[..4], b"XJS1");
        let opened = open_entry(&list, &env).unwrap();
        assert_eq!(
            opened.metadata_json,
            f["entry"]["expected_metadata_json"]
                .as_str()
                .unwrap()
                .as_bytes()
        );
        assert_eq!(opened.yjs, fixture_bytes(&f, "entry", "expected_yjs_b64"));
    }

    #[test]
    fn golden_web_envelopes_open_media_and_thumb() {
        let list = desktop_vault_list();
        let f = web_fixture();
        for section in ["media", "thumb"] {
            let env = fixture_bytes(&f, section, "envelope_b64");
            assert_eq!(env[0], 0x02, "{section} must be a V2 epoch envelope");
            assert_eq!(
                open_media(&list, &env).unwrap(),
                fixture_bytes(&f, section, "expected_b64"),
                "{section}"
            );
        }
    }

    #[test]
    fn golden_web_envelopes_tampering_fails() {
        let list = desktop_vault_list();
        let f = web_fixture();
        for section in ["media", "thumb"] {
            let env = fixture_bytes(&f, section, "envelope_b64");
            assert_eq!(
                open_media(&list, &flip_last_byte(&env)),
                Err(EnvelopeError::WrongKey),
                "{section}"
            );
        }
        let entry = fixture_bytes(&f, "entry", "envelope_b64");
        assert!(open_entry(&list, &flip_last_byte(&entry)).is_err());
    }

    #[test]
    fn golden_web_envelopes_wrong_epoch_fails() {
        let list = desktop_vault_list();
        let wrong = shifted_epochs(&list);
        let f = web_fixture();
        for section in ["media", "thumb"] {
            let env = fixture_bytes(&f, section, "envelope_b64");
            assert!(
                matches!(
                    open_media(&wrong, &env),
                    Err(EnvelopeError::UnknownEpoch(_))
                ),
                "{section}"
            );
        }
        let entry = fixture_bytes(&f, "entry", "envelope_b64");
        assert_eq!(
            open_entry(&wrong, &entry),
            Err(EnvelopeError::FingerprintMismatch)
        );
    }
}
