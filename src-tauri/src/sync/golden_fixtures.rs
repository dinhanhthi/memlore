//! Golden parity tests: the real sync engine against `memlore_core::envelope`.
//!
//! Test-only. Every provider here is fenced (`with_recovery_fence`, mirroring
//! `commands/sync.rs`), so files live at `generations/g-N/<device>/...`, the
//! layout a web device must read and write. An unfenced provider would use the
//! flat root and hide a wrong path.

use super::engine::{SyncEngine, SyncTrigger};
use super::keyring_v2::io::KeyringV2Io;
use super::local_provider::LocalSyncProvider;
use super::media_sync::{fetch_media, fetch_media_thumbnail};
use super::metadata::{DeviceMetadata, EntryMetadata, SyncMediaItem, SyncedEntrySummary};
use super::outbox_import::{
    collect_known_ids_from_manifests, run_outbox_import_cycle, NoopOutboxSink, PendingPlan,
};
use super::provider::{FileKind, SyncError, SyncProvider};
use crate::db;
use crate::utils::encryption::derive_sync_key;
use crate::EncryptionKeyState;
use async_trait::async_trait;
use memlore_core::envelope::{open_entry, open_media, seal_entry, seal_media, seal_thumb};
use memlore_core::key_state::ContentKeyList;
use memlore_core::outbox::{open_outbox_acks, OutboxFieldDecision};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};
use zeroize::Zeroizing;

const GEN: u64 = 3;
/// Test-only content key (epoch 1). Not a secret.
const CONTENT_KEY: [u8; 32] = [7u8; 32];

/// Provider built exactly like production: fenced at generation `gen`.
/// Also stamps `.meta/control.json` with that generation (a real vault always
/// has one) so the fence check passes.
pub(crate) fn fenced_provider(dir: &Path, gen: u64) -> LocalSyncProvider {
    let control = super::sync_control::SyncControlV1 {
        version: super::sync_control::SYNC_CONTROL_VERSION,
        recovery_generation: gen,
        recovery_lease: None,
        updated_at: 1,
    };
    std::fs::create_dir_all(dir.join(".meta")).unwrap();
    std::fs::write(
        dir.join(".meta/control.json"),
        serde_json::to_vec(&control).unwrap(),
    )
    .unwrap();
    LocalSyncProvider::new(dir.to_path_buf()).with_recovery_fence(gen, None)
}

fn gen_dir(dir: &TempDir) -> PathBuf {
    dir.path().join("generations").join(format!("g-{GEN}"))
}

fn engine(dir: &TempDir, device_id: &str) -> SyncEngine {
    SyncEngine::new(
        Arc::new(fenced_provider(dir.path(), GEN)),
        device_id.to_string(),
    )
}

fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::schema::migrate(&conn).unwrap();
    conn
}

/// Single-epoch content-key list, as the web builds it.
fn core_list() -> ContentKeyList {
    ContentKeyList {
        keys: BTreeMap::from([(1, Zeroizing::new(CONTENT_KEY))]),
        latest: 1,
        db_key: Zeroizing::new([0u8; 32]),
        master: Zeroizing::new(CONTENT_KEY),
    }
}

/// What `run_sync_now` hands the engine: `K1[latest]` (one HKDF step).
fn engine_key() -> Zeroizing<[u8; 32]> {
    derive_sync_key(&CONTENT_KEY)
}

/// The ingest-side snapshot (`snapshot_for_engine`, keys pre-derived once).
fn engine_state() -> EncryptionKeyState {
    let ks = EncryptionKeyState::new();
    ks.set_content_state(
        BTreeMap::from([(1, Zeroizing::new(CONTENT_KEY))]),
        1,
        Zeroizing::new([0u8; 32]),
        Zeroizing::new(CONTENT_KEY),
    )
    .unwrap();
    ks.snapshot_for_engine().unwrap()
}

fn yjs_blob(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let t = doc.get_or_insert_text("content");
    t.insert(&mut doc.transact_mut(), 0, text);
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    bytes
}

fn yjs_text(update: &[u8]) -> String {
    let doc = Doc::new();
    let t = doc.get_or_insert_text("content");
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
    let s = t.get_string(&doc.transact());
    s
}

fn default_journal(conn: &Connection) -> String {
    conn.query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
        .unwrap()
}

fn insert_entry(conn: &Connection, title: &str, text: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO entries (id, journal_id, title, preview_text, content_text,
            entry_date, created_at, updated_at, is_favorite, is_deleted, yjs_doc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6, 0, 0, ?7)",
        rusqlite::params![
            id,
            default_journal(conn),
            title,
            "p",
            text,
            1_700_000_000i64,
            yjs_blob(text)
        ],
    )
    .unwrap();
    db::mark_entry_pending(conn, &id).unwrap();
    id
}

fn peer_meta(
    conn: &Connection,
    entry_id: &str,
    title: &str,
    text: &str,
    media: Vec<SyncMediaItem>,
) -> EntryMetadata {
    let now = 1_700_000_100i64;
    EntryMetadata {
        entry_id: entry_id.to_string(),
        device_id: "dev-w".to_string(),
        updated_at: now,
        entry_date: 1_700_000_000,
        created_at: now,
        journal_id: default_journal(conn),
        journal_name: None,
        journal_color: None,
        journal_updated_at: None,
        title: Some(title.to_string()),
        preview_text: None,
        content_text: Some(text.to_string()),
        location_label: None,
        location_address: None,
        weather_summary: None,
        weather_icon: None,
        latitude: None,
        longitude: None,
        emotion: None,
        is_favorite: false,
        is_deleted: false,
        is_locked: false,
        is_invisible: false,
        vault_id: None,
        cover_media_id: None,
        entry_date_user_edited: false,
        content_language: None,
        tag_ids: vec![],
        media,
        deleted_media: vec![],
        trashed_at: None,
    }
}

fn write_peer(dir: &TempDir, rel: &str, bytes: &[u8]) {
    let path = gen_dir(dir).join("dev-w").join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// The plaintext `metadata.json` the engine's manifest diff needs to see the
/// peer's entry (scaffolding for the pull side; not a sealed format).
fn write_peer_manifest(dir: &TempDir, meta: &EntryMetadata) {
    let manifest = DeviceMetadata {
        device_id: "dev-w".to_string(),
        recovery_generation: GEN,
        entries: vec![SyncedEntrySummary {
            entry_id: meta.entry_id.clone(),
            updated_at: meta.updated_at,
            local_version: 1,
            is_deleted: false,
            trashed_at: None,
        }],
        journals: vec![],
        chats_present: false,
        memory_present: false,
        generated_at: meta.updated_at,
        index_present: false,
        outbox_versions: None,
    };
    write_peer(
        dir,
        "metadata.json",
        &serde_json::to_vec(&manifest).unwrap(),
    );
}

#[tokio::test]
async fn golden_engine_entry_opens_with_core_envelope() {
    let dir = TempDir::new().unwrap();
    let conn = fresh_db();
    let id = insert_entry(&conn, "Golden title", "golden body");

    engine(&dir, "dev-a")
        .push_single_entry(&conn, &engine_key(), &id)
        .await
        .unwrap();

    let path = gen_dir(&dir).join(format!("dev-a/entries/{id}.bin"));
    assert!(path.exists(), "fenced push lands under generations/g-N");
    assert!(!dir.path().join(format!("dev-a/entries/{id}.bin")).exists());

    let opened = open_entry(&core_list(), &std::fs::read(path).unwrap()).unwrap();
    let meta: EntryMetadata = serde_json::from_slice(&opened.metadata_json).unwrap();
    assert_eq!(meta.title.as_deref(), Some("Golden title"));
    assert_eq!(meta.content_text.as_deref(), Some("golden body"));
    assert_eq!(yjs_text(&opened.yjs), "golden body");
}

#[tokio::test]
async fn golden_core_sealed_entry_is_pulled_by_engine() {
    let dir = TempDir::new().unwrap();
    let conn = fresh_db();
    let id = uuid::Uuid::new_v4().to_string();
    let meta = peer_meta(&conn, &id, "From web", "web body", vec![]);
    let sealed = seal_entry(
        &core_list(),
        &serde_json::to_vec(&meta).unwrap(),
        &yjs_blob("web body"),
    )
    .unwrap();
    write_peer(&dir, &format!("entries/{id}.bin"), &sealed);
    write_peer_manifest(&dir, &meta);

    let stats = engine(&dir, "dev-a")
        .pull_remote(&conn, &engine_key(), &engine_state())
        .await
        .unwrap();
    assert_eq!(stats.pulled, 1, "warnings: {:?}", stats.warnings);

    let entry = db::get_entry(&conn, &id).unwrap().expect("entry pulled");
    assert_eq!(entry.title.as_deref(), Some("From web"));
    assert_eq!(entry.content_text.as_deref(), Some("web body"));
    let yjs = db::get_entry_content(&conn, &id).unwrap().unwrap();
    assert_eq!(yjs_text(&yjs), "web body");
}

#[tokio::test]
async fn golden_engine_media_and_thumb_open_with_core_envelope() {
    let dir = TempDir::new().unwrap();
    let conn = fresh_db();
    let id = insert_entry(&conn, "t", "b");
    let files = TempDir::new().unwrap();
    let media_path = files.path().join("photo.jpg");
    let thumb_path = files.path().join("photo.thumb.jpg");
    std::fs::write(&media_path, b"golden media bytes").unwrap();
    std::fs::write(&thumb_path, b"golden thumb bytes").unwrap();
    let media = db::create_media(
        &conn,
        db::CreateMediaParams {
            entry_id: &id,
            file_name: "photo.jpg",
            file_type: "image/jpeg",
            storage_path: &media_path.to_string_lossy(),
            file_size: Some(18),
            sort_order: 0,
            insertion_mode: "inline",
            width: None,
            height: None,
            exif_date: None,
            exif_latitude: None,
            exif_longitude: None,
        },
    )
    .unwrap();
    db::update_media_thumbnail_path(&conn, &media.id, Some(&thumb_path.to_string_lossy())).unwrap();

    let stats = engine(&dir, "dev-a")
        .push_local(&conn, &engine_key(), &engine_state(), SyncTrigger::Manual)
        .await
        .unwrap();
    assert_eq!(stats.media_uploaded, 1, "errors: {:?}", stats.errors);

    let base = gen_dir(&dir).join("dev-a/media");
    let full = std::fs::read(base.join(&media.id)).unwrap();
    let thumb = std::fs::read(base.join(format!("{}.thumb", media.id))).unwrap();
    assert_eq!(full[0], 0x02, "desktop writes the epoch envelope");
    assert_eq!(
        open_media(&core_list(), &full).unwrap(),
        b"golden media bytes"
    );
    assert_eq!(
        open_media(&core_list(), &thumb).unwrap(),
        b"golden thumb bytes"
    );
}

#[tokio::test]
async fn golden_core_sealed_media_and_thumb_are_read_by_engine() {
    let dir = TempDir::new().unwrap();
    let conn = fresh_db();
    let id = uuid::Uuid::new_v4().to_string();
    let media_id = uuid::Uuid::new_v4().to_string();
    let item = SyncMediaItem {
        id: media_id.clone(),
        file_name: "web.jpg".to_string(),
        file_type: "image/jpeg".to_string(),
        file_size: Some(15),
        sort_order: 0,
        created_at: 1_700_000_050,
        insertion_mode: "inline".to_string(),
        width: None,
        height: None,
        duration_seconds: None,
        exif_date: None,
        exif_latitude: None,
        exif_longitude: None,
    };
    let meta = peer_meta(&conn, &id, "With media", "body", vec![item]);
    let list = core_list();
    write_peer(
        &dir,
        &format!("entries/{id}.bin"),
        &seal_entry(
            &list,
            &serde_json::to_vec(&meta).unwrap(),
            &yjs_blob("body"),
        )
        .unwrap(),
    );
    write_peer_manifest(&dir, &meta);
    write_peer(
        &dir,
        &format!("media/{media_id}"),
        &seal_media(&list, b"web media bytes").unwrap(),
    );
    write_peer(
        &dir,
        &format!("media/{media_id}.thumb"),
        &seal_thumb(&list, b"web thumb bytes").unwrap(),
    );

    let eng = engine(&dir, "dev-a");
    eng.pull_remote(&conn, &engine_key(), &engine_state())
        .await
        .unwrap();
    let row = db::get_media(&conn, &media_id).unwrap().expect("media row");
    assert_eq!(
        row.cloud_path.as_deref(),
        Some(format!("dev-w/media/{media_id}").as_str())
    );

    let provider = fenced_provider(dir.path(), GEN);
    let cache = TempDir::new().unwrap();
    let ks = engine_state();
    let full = cache.path().join("web.jpg");
    fetch_media(&provider, &ks, &media_id, "dev-w", &full)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&full).unwrap(), b"web media bytes");
    let thumb = cache.path().join("web.thumb.jpg");
    fetch_media_thumbnail(&provider, &ks, &media_id, "dev-w", &thumb)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&thumb).unwrap(), b"web thumb bytes");
}

// ---------------------------------------------------------------------------
// Desktop golden fixture: `desktop-vault.v1.json`.
//
// A throwaway vault built through the real setup, keyring-publish and sync
// engine paths, frozen as JSON. It is the BACKWARD-COMPAT ORACLE for the v0.1.0
// formats: see `crates/memlore-core/fixtures/README.md`. Synthetic data only.
// ---------------------------------------------------------------------------

const FIXTURE_REL_PATH: &str = "crates/memlore-core/fixtures/desktop-vault.v1.json";
/// The standard all-zero-entropy BIP39 test vector (valid checksum). Not a secret.
const FIXTURE_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon art";
const FIXTURE_PASSWORD: &str = "12345678";
const FIXTURE_GEN: u64 = 0;
/// 1x1 PNG / 1x1 GIF: tiny stand-ins for the image and its thumbnail.
const TINY_PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_GIF_B64: &str = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_REL_PATH)
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .unwrap()
}

/// Real first-run setup (`begin_` + `confirm_first_time_setup_inner`), with the
/// randomly generated recovery phrase swapped for [`FIXTURE_PHRASE`] in the
/// pending row, exactly as if the user had been shown that phrase.
fn setup_fixture_vault() -> (
    crate::commands::crypto::V2KeyringPublishContext,
    crate::AppState,
    EncryptionKeyState,
) {
    use crate::commands::crypto::{begin_first_time_setup_inner, confirm_first_time_setup_inner};
    use crate::utils::encryption::{encrypt_data, unwrap_key, KdfParams};
    use crate::utils::recovery::{derive_recovery_key, validate_recovery_mnemonic};

    let conn = fresh_db();
    let handle =
        begin_first_time_setup_inner(&conn, FIXTURE_PASSWORD, "Golden Desktop", KdfParams::FAST)
            .unwrap();
    let mut row = db::get_pending_setup_by_id(&conn, &handle.setup_id)
        .unwrap()
        .unwrap();
    let master = unwrap_key(
        &row.wrapped_master,
        FIXTURE_PASSWORD,
        &hex::decode(&row.kek_salt).unwrap(),
    )
    .unwrap();
    let recovery_key = derive_recovery_key(&validate_recovery_mnemonic(FIXTURE_PHRASE).unwrap());
    row.recovery_wrapped = hex::encode(encrypt_data(&recovery_key, master.as_ref()).unwrap());
    row.mnemonic = FIXTURE_PHRASE.to_string();
    db::delete_pending_setup(&conn, &handle.setup_id).unwrap();
    db::insert_pending_setup(&conn, &row).unwrap();

    let words: Vec<&str> = FIXTURE_PHRASE.split_whitespace().collect();
    let answers: Vec<String> = handle
        .challenge_indices
        .iter()
        .map(|&i| words[i].to_string())
        .collect();
    let key_state = EncryptionKeyState::new();
    let (conn, ctx) = confirm_first_time_setup_inner(
        conn,
        &key_state,
        &handle.setup_id,
        &answers,
        FIXTURE_PASSWORD,
        Path::new(""),
        None,
        None,
        None,
    )
    .unwrap();
    (ctx, crate::AppState::new(conn), key_state)
}

fn collect_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    for item in std::fs::read_dir(dir).unwrap() {
        let path = item.unwrap().path();
        if path.is_dir() {
            collect_files(root, &path, out);
        } else {
            let rel = path.strip_prefix(root).unwrap();
            let rel = rel.to_string_lossy().replace('\\', "/");
            out.insert(rel, b64(&std::fs::read(&path).unwrap()));
        }
    }
}

/// Regenerates the committed fixture. Gated twice: `#[ignore]` AND the env var,
/// so a stray `--ignored` run never rewrites the oracle.
#[tokio::test]
#[ignore = "writes the frozen oracle; run only with MEMLORE_REGEN_FIXTURES=1"]
async fn golden_desktop_fixture_regen() {
    if std::env::var("MEMLORE_REGEN_FIXTURES").as_deref() != Ok("1") {
        eprintln!("MEMLORE_REGEN_FIXTURES=1 not set: fixture left untouched");
        return;
    }
    let dir = TempDir::new().unwrap();
    let provider = Arc::new(fenced_provider(dir.path(), FIXTURE_GEN));
    let (ctx, state, key_state) = setup_fixture_vault();
    crate::commands::gdrive::publish_v2_keyring_with_provider(&*provider, &state, &ctx, &key_state)
        .await
        .unwrap();

    // Seven synthetic entries. Index 1 carries tags, emotion, favorite and a
    // custom journal; index 5 is locked; index 6 carries the image.
    let media_dir = TempDir::new().unwrap();
    let png = unb64(TINY_PNG_B64);
    let gif = unb64(TINY_GIF_B64);
    let (entries, media_id, version_id) = {
        let conn = state.lock().unwrap();
        let texts = [
            ("Golden one", "First golden body"),
            ("Golden two", "Second golden body with tags"),
            ("Golden three", "Third golden body"),
            ("Golden four", "Fourth golden body"),
            ("Golden five", "Xin chào, đây là bản ghi thứ năm"),
            ("Golden six", "Sixth golden body, locked"),
            ("Golden seven", "Seventh golden body with an image"),
        ];
        let ids: Vec<String> = texts
            .iter()
            .map(|(t, b)| insert_entry(&conn, t, b))
            .collect();
        let journal = db::create_journal(&conn, "Golden journal", Some("#336699")).unwrap();
        db::move_entry_to_journal(&conn, &ids[1], &journal.id).unwrap();
        for name in ["alpha", "beta"] {
            let tag = db::create_tag(&conn, name, None).unwrap();
            db::add_tag_to_entry(&conn, &ids[1], &tag.id).unwrap();
        }
        assert!(db::toggle_favorite(&conn, &ids[1]).unwrap());
        db::update_entry_emotion(&conn, &ids[1], Some("good")).unwrap();
        db::update_entry_emotion(&conn, &ids[2], Some("bad")).unwrap();
        db::update_entry_emotion(&conn, &ids[3], Some("neutral")).unwrap();
        db::set_entry_locked(&conn, &ids[5], true).unwrap();

        let media_path = media_dir.path().join("golden.png");
        let thumb_path = media_dir.path().join("golden.thumb.gif");
        std::fs::write(&media_path, &png).unwrap();
        std::fs::write(&thumb_path, &gif).unwrap();
        let media = db::create_media(
            &conn,
            db::CreateMediaParams {
                entry_id: &ids[6],
                file_name: "golden.png",
                file_type: "image/png",
                storage_path: &media_path.to_string_lossy(),
                file_size: Some(png.len() as i64),
                sort_order: 0,
                insertion_mode: "inline",
                width: Some(1),
                height: Some(1),
                exif_date: None,
                exif_latitude: None,
                exif_longitude: None,
            },
        )
        .unwrap();
        db::update_media_thumbnail_path(&conn, &media.id, Some(&thumb_path.to_string_lossy()))
            .unwrap();

        let version_id = db::insert_entry_version(
            &conn,
            &ids[0],
            &yjs_blob(texts[0].1),
            "Golden version preview",
            &ctx.device_id,
        )
        .unwrap();
        for id in &ids {
            db::mark_entry_pending(&conn, id).unwrap();
        }
        let entries: Vec<serde_json::Value> = ids
            .iter()
            .zip(texts)
            .enumerate()
            .map(|(i, (id, (title, text)))| {
                serde_json::json!({
                    "entry_id": id,
                    "title": title,
                    "content_text": text,
                    "journal_name": if i == 1 { "Golden journal" } else { "My Journal" },
                    "tags": if i == 1 { vec!["alpha", "beta"] } else { vec![] },
                    "emotion": match i { 1 => Some("good"), 2 => Some("bad"), 3 => Some("neutral"), _ => None },
                    "is_favorite": i == 1,
                    "is_locked": i == 5,
                    "media_ids": if i == 6 { vec![media.id.clone()] } else { vec![] },
                })
            })
            .collect();
        (entries, media.id, version_id)
    };

    let key = key_state.with_sync_key(|k| Ok(Zeroizing::new(*k))).unwrap();
    let snapshot = key_state.snapshot_for_engine().unwrap();
    let summary = SyncEngine::new(provider.clone(), ctx.device_id.clone())
        .sync_now(&state, &key, &snapshot, SyncTrigger::Manual)
        .await
        .unwrap();
    assert!(
        summary.errors.is_empty(),
        "sync errors: {:?}",
        summary.errors
    );

    let mut files = BTreeMap::new();
    collect_files(dir.path(), dir.path(), &mut files);
    let fixture = serde_json::json!({
        "fixture_version": 1,
        "recovery_phrase": FIXTURE_PHRASE,
        "password": FIXTURE_PASSWORD,
        "device_id": ctx.device_id,
        "generation": FIXTURE_GEN,
        "files": files,
        "expected": {
            "entries": entries,
            "media": [{
                "media_id": media_id,
                "entry_index": 6,
                "file_name": "golden.png",
                "file_type": "image/png",
                "bytes_b64": b64(&png),
                "thumb_b64": b64(&gif),
            }],
            "versions": [{
                "version_id": version_id,
                "entry_index": 0,
                "preview_text": "Golden version preview",
                "content_text": entries[0]["content_text"].clone(),
            }],
            "tags": ["alpha", "beta"],
        },
    });
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
}

/// Today's desktop decodes the committed fixture, through BOTH decoders: the
/// real engine (`pull_remote` + `fetch_media`) and `memlore_core::envelope`.
#[tokio::test]
async fn golden_desktop_fixture_decodes() {
    use memlore_core::envelope::{
        load_content_list, open_device_bin, unwrap_master_with_recovery, verify_master_fingerprint,
    };
    use serde_json::Value;

    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).unwrap()).unwrap();
    let files: BTreeMap<String, Vec<u8>> = fixture["files"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), unb64(v.as_str().unwrap())))
        .collect();
    let device = fixture["device_id"].as_str().unwrap();
    let gen = fixture["generation"].as_u64().unwrap();
    let base = format!("generations/g-{gen}/{device}");
    let json_of = |path: &str| -> Value { serde_json::from_slice(&files[path]).unwrap() };
    let expected = &fixture["expected"];

    // Core envelope: phrase -> master -> content list -> every sealed file.
    let recovery = json_of(".meta/keyring/_recovery.json");
    let meta = json_of(".meta/keyring/_meta.json");
    let phrase = fixture["recovery_phrase"].as_str().unwrap();
    let master =
        unwrap_master_with_recovery(phrase, recovery["wrapped_master"].as_str().unwrap()).unwrap();
    verify_master_fingerprint(&master, meta["master_fingerprint"].as_str().unwrap()).unwrap();
    let list = load_content_list(
        std::str::from_utf8(&files[".meta/keyring/_content.json"]).unwrap(),
        &master,
    )
    .unwrap();

    let expected_entries = expected["entries"].as_array().unwrap();
    assert_eq!(expected_entries.len(), 7);
    for e in expected_entries {
        let id = e["entry_id"].as_str().unwrap();
        let opened = open_entry(&list, &files[&format!("{base}/entries/{id}.bin")]).unwrap();
        let m: EntryMetadata = serde_json::from_slice(&opened.metadata_json).unwrap();
        assert_eq!(m.title.as_deref(), e["title"].as_str());
        assert_eq!(m.content_text.as_deref(), e["content_text"].as_str());
        assert_eq!(m.emotion.as_deref(), e["emotion"].as_str());
        assert_eq!(m.is_favorite, e["is_favorite"].as_bool().unwrap());
        assert_eq!(m.is_locked, e["is_locked"].as_bool().unwrap());
        assert_eq!(m.journal_name.as_deref(), e["journal_name"].as_str());
        assert_eq!(m.tag_ids.len(), e["tags"].as_array().unwrap().len());
        assert_eq!(m.media.len(), e["media_ids"].as_array().unwrap().len());
        assert_eq!(yjs_text(&opened.yjs), e["content_text"].as_str().unwrap());
    }
    let m = &expected["media"][0];
    let media_id = m["media_id"].as_str().unwrap();
    let want = unb64(m["bytes_b64"].as_str().unwrap());
    let want_thumb = unb64(m["thumb_b64"].as_str().unwrap());
    let full = &files[&format!("{base}/media/{media_id}")];
    let thumb = &files[&format!("{base}/media/{media_id}.thumb")];
    assert_eq!(open_media(&list, full).unwrap(), want);
    assert_eq!(open_media(&list, thumb).unwrap(), want_thumb);
    let tags: Value = serde_json::from_slice(
        &open_device_bin(&list, &files[&format!("{base}/tags.bin")]).unwrap(),
    )
    .unwrap();
    let tags_text = tags.to_string();
    for name in expected["tags"].as_array().unwrap() {
        assert!(
            tags_text.contains(name.as_str().unwrap()),
            "tags.bin: {tags_text}"
        );
    }

    // Desktop engine: materialise the files, pull as a second device.
    let dir = TempDir::new().unwrap();
    for (rel, bytes) in &files {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    let provider =
        Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(gen, None));
    let ks = EncryptionKeyState::new();
    ks.set_content_state(
        list.keys.clone(),
        list.latest,
        Zeroizing::new([0u8; 32]),
        Zeroizing::new(*master),
    )
    .unwrap();
    let key = ks.with_sync_key(|k| Ok(Zeroizing::new(*k))).unwrap();
    let snapshot = ks.snapshot_for_engine().unwrap();
    let conn = fresh_db();
    let engine = SyncEngine::new(provider.clone(), "dev-reader".to_string());
    let stats = engine.pull_remote(&conn, &key, &snapshot).await.unwrap();
    assert_eq!(stats.pulled, 7, "warnings: {:?}", stats.warnings);

    let all_tags = db::list_tags(&conn, None).unwrap();
    for e in expected_entries {
        let id = e["entry_id"].as_str().unwrap();
        let row = db::get_entry_raw(&conn, id).unwrap().expect("entry pulled");
        assert_eq!(row.title.as_deref(), e["title"].as_str());
        assert_eq!(row.content_text.as_deref(), e["content_text"].as_str());
        assert_eq!(row.emotion.as_deref(), e["emotion"].as_str());
        assert_eq!(row.is_favorite, e["is_favorite"].as_bool().unwrap());
        let journal = db::get_journal(&conn, &row.journal_id).unwrap().unwrap();
        assert_eq!(Some(journal.name.as_str()), e["journal_name"].as_str());
        let mut names: Vec<String> = db::get_tag_ids_for_entry(&conn, id)
            .unwrap()
            .iter()
            .map(|t| all_tags.iter().find(|x| &x.id == t).unwrap().name.clone())
            .collect();
        names.sort();
        let want_names: Vec<&str> = e["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(names, want_names);
        let yjs = db::get_entry_content(&conn, id).unwrap().unwrap();
        assert_eq!(yjs_text(&yjs), e["content_text"].as_str().unwrap());
    }
    let cache = TempDir::new().unwrap();
    let out = cache.path().join("golden.png");
    fetch_media(&*provider, &snapshot, media_id, device, &out)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), want);
    let out = cache.path().join("golden.thumb");
    fetch_media_thumbnail(&*provider, &snapshot, media_id, device, &out)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), want_thumb);

    let v = &expected["versions"][0];
    let versions =
        db::list_entry_versions(&conn, expected_entries[0]["entry_id"].as_str().unwrap()).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].id, v["version_id"].as_str().unwrap());
    assert_eq!(
        versions[0].preview_text,
        v["preview_text"].as_str().unwrap()
    );
}

// ---------------------------------------------------------------------------
// Web outbox golden fixtures: `web-outbox.v1.json`
// ---------------------------------------------------------------------------

const WEB_OUTBOX_FIXTURE_REL_PATH: &str = "crates/memlore-core/fixtures/web-outbox.v1.json";

fn web_outbox_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(WEB_OUTBOX_FIXTURE_REL_PATH)
}

struct GoldenOutboxCloud {
    dir: TempDir,
    provider: Arc<LocalSyncProvider>,
    #[allow(dead_code)]
    master: Zeroizing<[u8; 32]>,
    list: ContentKeyList,
    key_state: EncryptionKeyState,
    engine_key: Zeroizing<[u8; 32]>,
    #[allow(dead_code)]
    desktop_device_id: String,
    web_device_id: String,
    #[allow(dead_code)]
    gen: u64,
    #[allow(dead_code)]
    desktop_fixture: serde_json::Value,
    web_fixture: serde_json::Value,
    master_fingerprint: String,
}

fn setup_golden_outbox_cloud() -> GoldenOutboxCloud {
    use memlore_core::envelope::{
        load_content_list, unwrap_master_with_recovery, verify_master_fingerprint,
    };
    use serde_json::Value;

    let desktop_fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).unwrap()).unwrap();
    let web_fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(web_outbox_fixture_path()).unwrap()).unwrap();

    let mut all_files = BTreeMap::new();
    for (k, v) in desktop_fixture["files"].as_object().unwrap() {
        all_files.insert(k.clone(), unb64(v.as_str().unwrap()));
    }
    for (k, v) in web_fixture["files"].as_object().unwrap() {
        all_files.insert(k.clone(), unb64(v.as_str().unwrap()));
    }

    let dir = TempDir::new().unwrap();
    for (rel, bytes) in &all_files {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    let gen = desktop_fixture["generation"].as_u64().unwrap();
    let provider =
        Arc::new(LocalSyncProvider::new(dir.path().to_path_buf()).with_recovery_fence(gen, None));

    let phrase = desktop_fixture["recovery_phrase"].as_str().unwrap();
    let recovery_json: Value =
        serde_json::from_slice(&all_files[".meta/keyring/_recovery.json"]).unwrap();
    let meta_json: Value = serde_json::from_slice(&all_files[".meta/keyring/_meta.json"]).unwrap();

    let master =
        unwrap_master_with_recovery(phrase, recovery_json["wrapped_master"].as_str().unwrap())
            .unwrap();
    let master_fingerprint = meta_json["master_fingerprint"]
        .as_str()
        .unwrap()
        .to_string();
    verify_master_fingerprint(&master, &master_fingerprint).unwrap();

    let list = load_content_list(
        std::str::from_utf8(&all_files[".meta/keyring/_content.json"]).unwrap(),
        &master,
    )
    .unwrap();

    let ks = EncryptionKeyState::new();
    ks.set_content_state(
        list.keys.clone(),
        list.latest,
        Zeroizing::new([0u8; 32]),
        Zeroizing::new(*master),
    )
    .unwrap();

    let key = ks.with_sync_key(|k| Ok(Zeroizing::new(*k))).unwrap();
    let desktop_device_id = desktop_fixture["device_id"].as_str().unwrap().to_string();
    let web_device_id = web_fixture["web_device_id"].as_str().unwrap().to_string();

    GoldenOutboxCloud {
        dir,
        provider,
        master,
        list,
        key_state: ks,
        engine_key: key,
        desktop_device_id,
        web_device_id,
        gen,
        desktop_fixture,
        web_fixture,
        master_fingerprint,
    }
}

impl GoldenOutboxCloud {
    async fn list_outbox_files(&self, device_id: &str) -> Result<Vec<String>, SyncError> {
        SyncProvider::list_files(&*self.provider, device_id, FileKind::Outbox).await
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        SyncProvider::read_file(&*self.provider, path).await
    }
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        SyncProvider::write_file(&*self.provider, path, data).await
    }
    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        SyncProvider::delete_file(&*self.provider, path).await
    }
}

async fn run_desktop_sync_and_import(
    provider: &Arc<LocalSyncProvider>,
    device_id: &str,
    conn: &Connection,
    ks: &EncryptionKeyState,
    engine_key: &[u8; 32],
    media_dir: &Path,
) -> (
    crate::sync::engine::SyncSummary,
    crate::sync::outbox_import::OutboxImportSummary,
) {
    let engine = SyncEngine::new(provider.clone(), device_id.to_string());
    let snapshot = ks.snapshot_for_engine().unwrap();
    let summary = engine
        .sync_now(conn, engine_key, &snapshot, SyncTrigger::Manual)
        .await
        .unwrap();

    let (known_ids, pull_clean) = if summary.pull_clean {
        match engine.fetch_manifests(true).await {
            Ok((manifests, errors)) if errors.is_empty() => {
                (collect_known_ids_from_manifests(&manifests), true)
            }
            _ => (std::collections::HashMap::new(), false),
        }
    } else {
        (std::collections::HashMap::new(), false)
    };

    let key_list = ks.content_key_list().unwrap();
    let sink = NoopOutboxSink;
    let import_summary = run_outbox_import_cycle(
        provider.as_ref(),
        provider.as_ref(),
        device_id,
        &key_list,
        known_ids,
        pull_clean,
        &summary,
        media_dir,
        conn,
        &sink,
    )
    .await
    .unwrap();

    (summary, import_summary)
}

struct CountingOutboxProvider {
    inner: Arc<LocalSyncProvider>,
    outbox_calls: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl SyncProvider for CountingOutboxProvider {
    async fn list_devices(&self) -> Result<Vec<String>, SyncError> {
        SyncProvider::list_devices(&*self.inner).await
    }

    async fn list_files(&self, device_id: &str, kind: FileKind) -> Result<Vec<String>, SyncError> {
        if kind == FileKind::Outbox {
            self.outbox_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        SyncProvider::list_files(&*self.inner, device_id, kind).await
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        SyncProvider::read_file(&*self.inner, path).await
    }

    async fn read_file_if_changed(
        &self,
        path: &str,
        known_revision: Option<&str>,
    ) -> Result<crate::sync::provider::ConditionalRead, SyncError> {
        SyncProvider::read_file_if_changed(&*self.inner, path, known_revision).await
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        SyncProvider::write_file(&*self.inner, path, data).await
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        SyncProvider::delete_file(&*self.inner, path).await
    }
}

#[async_trait]
impl KeyringV2Io for CountingOutboxProvider {
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        KeyringV2Io::read_file(&*self.inner, path).await
    }

    async fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), SyncError> {
        KeyringV2Io::write_file(&*self.inner, path, bytes).await
    }

    async fn delete_file(&self, path: &str) -> Result<(), SyncError> {
        KeyringV2Io::delete_file(&*self.inner, path).await
    }

    async fn list_files(&self, prefix: &str) -> Result<Vec<String>, SyncError> {
        KeyringV2Io::list_files(&*self.inner, prefix).await
    }

    fn configure_recovery_fence(
        &self,
        generation: u64,
        permit: Option<crate::sync::recovery::RecoveryOwnerPermit>,
    ) {
        self.inner.configure_recovery_fence(generation, permit);
    }
}

/// (a) Pull + import created entry with media, edited entry with text merge;
/// (b) untouched desktop rows unchanged, locked refused, unsupported version skipped_version;
/// (c) fresh empty desktop produces identical result.
#[tokio::test]
async fn golden_outbox_pull_and_import() {
    let cloud = setup_golden_outbox_cloud();
    let media_dir_a = TempDir::new().unwrap();
    let conn_a = fresh_db();
    let dev_a = "00000000-0000-0000-0000-000000000001";

    let (summary_a, import_summary_a) = run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;

    assert_eq!(summary_a.pulled, 7, "pulled 7 remote entries");
    assert_eq!(
        import_summary_a.intents_applied, 2,
        "applied created and edited"
    );
    assert_eq!(
        import_summary_a.intents_refused, 2,
        "refused locked and unsupported"
    );
    assert_eq!(
        import_summary_a.media_downloaded, 1,
        "downloaded 1 media item"
    );
    assert!(import_summary_a.acks_written, "desktop wrote its own acks");

    // (a) Created entry verification
    let created_id = cloud.web_fixture["expected"]["created_entry_id"]
        .as_str()
        .unwrap();
    let row_created = db::get_entry_raw(&conn_a, created_id)
        .unwrap()
        .expect("created entry exists in DB");
    assert_eq!(row_created.title.as_deref(), Some("Web Created Entry"));
    assert_eq!(
        row_created.content_text.as_deref(),
        Some("Web created body with image")
    );
    assert_eq!(
        row_created.preview_text.as_deref(),
        Some("Web created body with image")
    );
    assert_eq!(
        row_created.journal_id,
        "4fd64221-d0eb-4bc0-84c9-810bce934d16"
    );
    let yjs_created = db::get_entry_content(&conn_a, created_id).unwrap().unwrap();
    assert!(yjs_text(&yjs_created).contains("Web created body with image"));

    // (a) Edited entry verification (text merge + metadata patch)
    let edited_id = cloud.web_fixture["expected"]["edited_entry_id"]
        .as_str()
        .unwrap();
    let row_edited = db::get_entry_raw(&conn_a, edited_id)
        .unwrap()
        .expect("edited entry exists in DB");
    assert_eq!(
        row_edited.title.as_deref(),
        Some("Golden one edited by web")
    );
    assert_eq!(row_edited.emotion.as_deref(), Some("good"));
    assert_eq!(row_edited.is_favorite, true);
    assert_eq!(
        row_edited.journal_id,
        "4fd64221-d0eb-4bc0-84c9-810bce934d16"
    );
    let yjs_edited = db::get_entry_content(&conn_a, edited_id).unwrap().unwrap();
    let merged_text = yjs_text(&yjs_edited);
    assert!(
        merged_text.contains("First golden body"),
        "contains desktop text: {merged_text}"
    );
    assert!(
        merged_text.contains("+ Web append text"),
        "contains web text: {merged_text}"
    );

    // (a) Media file and thumbnail verification
    let media_id = cloud.web_fixture["expected"]["media_id"].as_str().unwrap();
    assert!(
        media_dir_a.path().join(format!("{media_id}.png")).exists(),
        "full media file on disk"
    );
    assert!(
        media_dir_a
            .path()
            .join(format!("{media_id}.thumb.jpg"))
            .exists(),
        "thumb file on disk"
    );
    let media_row = db::get_media(&conn_a, media_id)
        .unwrap()
        .expect("media row in DB");
    assert_eq!(media_row.file_name, format!("{media_id}.png"));
    assert_eq!(media_row.file_type, "image/png");

    // (b) Locked target refused and unchanged
    let locked_id = cloud.web_fixture["expected"]["locked_entry_id"]
        .as_str()
        .unwrap();
    let row_locked = db::get_entry_raw(&conn_a, locked_id)
        .unwrap()
        .expect("locked entry exists");
    assert_eq!(
        row_locked.title.as_deref(),
        Some("Golden six"),
        "locked entry title untouched"
    );
    let locked_path = format!("{}/outbox/{locked_id}.bin", cloud.web_device_id);
    let rec_locked = db::queries::outbox_import_get(&conn_a, &locked_path)
        .unwrap()
        .expect("locked record exists");
    assert_eq!(rec_locked.outcome, "refused");

    // (b) Unsupported version skipped_version
    let unsupported_id = cloud.web_fixture["expected"]["unsupported_entry_id"]
        .as_str()
        .unwrap();
    let unsupp_path = format!("{}/outbox/{unsupported_id}.bin", cloud.web_device_id);
    let rec_unsupp = db::queries::outbox_import_get(&conn_a, &unsupp_path)
        .unwrap()
        .expect("unsupported record exists");
    assert_eq!(rec_unsupp.outcome, "skipped_version");

    // (b) Untouched desktop rows unchanged
    let untouched_ids = [
        "64c4c37b-27b7-48b6-a0b7-ff83545e0c87",
        "bfd06ad9-bb0f-43e2-9b24-0bee3fbe1fcd",
        "d572a028-9099-43cb-88a5-3e0b1e6d5573",
        "80c8978d-6e44-41b6-aabd-d2f828958c62",
        "1cd8057a-38a2-4883-91cd-a096700ff1b2",
    ];
    for uid in &untouched_ids {
        assert!(
            db::get_entry_raw(&conn_a, uid).unwrap().is_some(),
            "untouched entry {uid} survives"
        );
    }

    // (c) Fresh empty desktop produces identical result
    let media_dir_c = TempDir::new().unwrap();
    let conn_c = fresh_db();
    let dev_c = "00000000-0000-0000-0000-000000000004";
    let (_, import_summary_c) = run_desktop_sync_and_import(
        &cloud.provider,
        dev_c,
        &conn_c,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_c.path(),
    )
    .await;
    assert_eq!(import_summary_c.intents_applied, 2);
    assert_eq!(import_summary_c.intents_refused, 2);
    let row_c_created = db::get_entry_raw(&conn_c, created_id).unwrap().unwrap();
    assert_eq!(row_c_created.title, row_created.title);
    assert_eq!(row_c_created.content_text, row_created.content_text);
    let row_c_edited = db::get_entry_raw(&conn_c, edited_id).unwrap().unwrap();
    assert_eq!(row_c_edited.title, row_edited.title);
    assert_eq!(row_c_edited.emotion, row_edited.emotion);
}

/// (d) Keyring rotation leaves outbox untouched; web slot deleted by publish_keyring;
/// (e) Authoritative cloud cleanup deletes outbox.
#[tokio::test]
async fn golden_outbox_rotation_and_cleanup() {
    let cloud = setup_golden_outbox_cloud();
    let files_before = cloud.list_outbox_files(&cloud.web_device_id).await.unwrap();
    assert_eq!(files_before.len(), 6, "6 outbox files initially present");

    let (_publish_ctx, app_state, ks) = setup_fixture_vault();
    {
        let conn = app_state.lock().unwrap();
        db::set_setting(
            &conn,
            db::CLOUD_MASTER_FINGERPRINT,
            &cloud.master_fingerprint,
        )
        .unwrap();
    }

    // Run rotation
    let (rotation_id, rot_ctx, new_epoch) = crate::sync::rotation::rotate::rotate_keys(
        cloud.provider.as_ref(),
        &app_state,
        &ks,
        FIXTURE_PASSWORD,
        None,
        Some(FIXTURE_PHRASE),
        None,
    )
    .await
    .unwrap();

    crate::sync::rotation::publish::publish_keyring(
        cloud.provider.as_ref(),
        &app_state,
        rotation_id,
        &rot_ctx,
        crate::sync::rotation::RecoverySource::Stashed,
        None,
        new_epoch,
    )
    .await
    .unwrap();

    // (d) Outbox files untouched by rotation
    let files_after = cloud.list_outbox_files(&cloud.web_device_id).await.unwrap();
    assert_eq!(
        files_before, files_after,
        "outbox files untouched by keyring rotation"
    );

    // (d) Web slot deleted by publish_keyring
    let slots = crate::sync::keyring_v2::io::list_device_slots(cloud.provider.as_ref())
        .await
        .unwrap();
    assert!(
        !slots.iter().any(|s| s.device_id == cloud.web_device_id),
        "web slot was deleted by publish_keyring"
    );

    // (e) Authoritative cloud cleanup deletes outbox
    let control = crate::sync::sync_control::SyncControlV1 {
        version: crate::sync::sync_control::SYNC_CONTROL_VERSION,
        recovery_generation: 0,
        recovery_lease: None,
        updated_at: 1,
    };
    std::fs::write(
        cloud.dir.path().join(".meta/control.json"),
        serde_json::to_vec(&control).unwrap(),
    )
    .unwrap();

    cloud
        .provider
        .clear_cloud_preserving_control()
        .await
        .unwrap();

    let files_cleaned = cloud.list_outbox_files(&cloud.web_device_id).await.unwrap();
    assert!(
        files_cleaned.is_empty(),
        "authoritative cloud cleanup deletes outbox"
    );
}

/// (f) A desktop with the importer disabled ignores the web folder entirely.
#[tokio::test]
async fn golden_outbox_disabled_importer_ignores_web() {
    let cloud = setup_golden_outbox_cloud();
    let conn = fresh_db();
    let dev = "00000000-0000-0000-0000-000000000005";

    // Legacy / disabled engine: only runs pull_remote, never calls run_outbox_import_cycle
    let engine = SyncEngine::new(cloud.provider.clone(), dev.to_string());
    let stats = engine
        .pull_remote(
            &conn,
            &cloud.engine_key,
            &cloud.key_state.snapshot_for_engine().unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(stats.pulled, 7, "pulled 7 regular desktop entries");

    let created_id = cloud.web_fixture["expected"]["created_entry_id"]
        .as_str()
        .unwrap();
    let media_id = cloud.web_fixture["expected"]["media_id"].as_str().unwrap();
    assert!(
        db::get_entry_raw(&conn, created_id).unwrap().is_none(),
        "web entry not imported"
    );
    assert!(
        db::get_media(&conn, media_id).unwrap().is_none(),
        "web media not imported"
    );
    assert!(
        db::queries::outbox_imports_list_all(&conn)
            .unwrap()
            .is_empty(),
        "no import records written"
    );
}

/// (g) Double import convergence;
/// (k) Propagation: importing desktop pushes, second desktop pulls;
/// (i6) Acks carry applied_updated_at equal to post-import updated_at.
#[tokio::test]
async fn golden_outbox_convergence_and_propagation() {
    let cloud = setup_golden_outbox_cloud();
    let media_dir_a = TempDir::new().unwrap();
    let conn_a = fresh_db();
    let dev_a = "00000000-0000-0000-0000-000000000001";

    // Cycle 1: initial import
    let (_, imp1) = run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;
    assert_eq!(imp1.intents_applied, 2);

    // (g) Cycle 2: unchanged intents skip cleanly, 0 applied; Desktop A pushes imported entries to cloud
    let (summary2, imp2) = run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;
    assert_eq!(imp2.intents_applied, 0, "second import cycle applies 0");
    assert_eq!(
        imp2.intents_skipped_unchanged, 4,
        "4 intents skipped unchanged, including the unsupported-version one"
    );
    assert_eq!(
        imp2.intents_refused, 0,
        "an unchanged unsupported-version intent is not re-read"
    );
    assert!(summary2.pushed >= 1, "Desktop A pushed at least 1 entry");

    // (k) Second desktop B pulls the imported entry from Desktop A
    let conn_b = fresh_db();
    let dev_b = "00000000-0000-0000-0000-000000000006";
    let engine_b = SyncEngine::new(cloud.provider.clone(), dev_b.to_string());
    let pull_stats = engine_b
        .pull_remote(
            &conn_b,
            &cloud.engine_key,
            &cloud.key_state.snapshot_for_engine().unwrap(),
        )
        .await
        .unwrap();
    assert!(
        pull_stats.pulled >= 1,
        "Desktop B pulled propagated entries"
    );
    let created_id = cloud.web_fixture["expected"]["created_entry_id"]
        .as_str()
        .unwrap();
    assert!(
        db::get_entry_raw(&conn_b, created_id).unwrap().is_some(),
        "Desktop B has propagated web entry"
    );

    // (i6) Acks carry applied_updated_at equal to post-import updated_at
    let acks_bytes = cloud
        .read_file(&format!("{dev_a}/outbox-acks.bin"))
        .await
        .unwrap();
    let acks = open_outbox_acks(&cloud.list, &acks_bytes).unwrap();
    let expected_path = format!("{}/outbox/{created_id}.bin", cloud.web_device_id);
    let ack = acks
        .acks
        .iter()
        .find(|a| a.path == expected_path)
        .expect("ack exists for created entry");
    let entry_a = db::get_entry_raw(&conn_a, created_id).unwrap().unwrap();
    assert_eq!(
        ack.applied_updated_at,
        Some(entry_a.updated_at),
        "applied_updated_at matches published updated_at"
    );
}

/// (h) No resurrection through a fresh desktop;
/// (j) Steady state: tombstone peer unchanged, web re-pushes, D does not create E.
#[tokio::test]
async fn golden_outbox_no_resurrection() {
    let cloud = setup_golden_outbox_cloud();
    let media_dir_a = TempDir::new().unwrap();
    let conn_a = fresh_db();
    let dev_a = "00000000-0000-0000-0000-000000000001";

    run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;

    let created_id = cloud.web_fixture["expected"]["created_entry_id"]
        .as_str()
        .unwrap();
    // Desktop A soft deletes E and pushes tombstone
    db::soft_delete_entry(&conn_a, created_id).unwrap();
    db::mark_entry_pending(&conn_a, created_id).unwrap();
    let engine_a = SyncEngine::new(cloud.provider.clone(), dev_a.to_string());
    engine_a
        .push_local(
            &conn_a,
            &cloud.engine_key,
            &cloud.key_state,
            SyncTrigger::Manual,
        )
        .await
        .unwrap();

    // (h) Fresh Desktop B pulls and imports: E stays deleted
    let conn_b = fresh_db();
    let media_dir_b = TempDir::new().unwrap();
    let dev_b = "00000000-0000-0000-0000-000000000006";
    run_desktop_sync_and_import(
        &cloud.provider,
        dev_b,
        &conn_b,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_b.path(),
    )
    .await;

    let entry_b = db::get_entry_raw(&conn_b, created_id).unwrap();
    assert!(
        entry_b.is_none() || entry_b.unwrap().is_deleted,
        "E stays deleted on fresh Desktop B"
    );

    // (j) Steady state: web re-pushes created-on-web intent for E
    let outbox_path = format!("{}/outbox/{created_id}.bin", cloud.web_device_id);
    let bytes = cloud.read_file(&outbox_path).await.unwrap();
    cloud.write_file(&outbox_path, &bytes).await.unwrap();

    run_desktop_sync_and_import(
        &cloud.provider,
        dev_b,
        &conn_b,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_b.path(),
    )
    .await;

    let entry_b_again = db::get_entry_raw(&conn_b, created_id).unwrap();
    assert!(
        entry_b_again.is_none() || entry_b_again.unwrap().is_deleted,
        "E stays deleted in steady state"
    );
}

/// (i) Wipe and reimport through real sync order (push -> pull -> import):
/// own acks prevent resurrection, survives second wipe and new web revision.
#[tokio::test]
async fn golden_outbox_wipe_and_reimport() {
    let cloud = setup_golden_outbox_cloud();
    let media_dir_a = TempDir::new().unwrap();
    let conn_a = fresh_db();
    let dev_a = "00000000-0000-0000-0000-000000000001";

    // 1. Desktop A imports web-created E
    run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;
    let created_id = cloud.web_fixture["expected"]["created_entry_id"]
        .as_str()
        .unwrap();

    // 2. Desktop A deletes E
    db::soft_delete_entry(&conn_a, created_id).unwrap();
    db::mark_entry_pending(&conn_a, created_id).unwrap();

    // 3. Desktop A runs ReplaceAll restore (hard_wipe_user_data)
    db::queries::hard_wipe_user_data(&conn_a).unwrap();

    // 4 & 5. The next sync pushes, pulls and imports: E is NOT recreated
    run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;
    assert!(
        db::get_entry_raw(&conn_a, created_id).unwrap().is_none(),
        "E not recreated because own acks had created=true"
    );

    // 6. Run one more cycle, SECOND ReplaceAll, new web revision of E
    db::queries::hard_wipe_user_data(&conn_a).unwrap();
    let outbox_path = format!("{}/outbox/{created_id}.bin", cloud.web_device_id);
    let bytes = cloud.read_file(&outbox_path).await.unwrap();
    cloud.write_file(&outbox_path, &bytes).await.unwrap();

    run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;
    assert!(
        db::get_entry_raw(&conn_a, created_id).unwrap().is_none(),
        "E still not recreated after second wipe"
    );
}

/// (i2) Behind desktop with pull_clean = false;
/// (i3) Crash mid-intent resumes from pending row;
/// (i4) Acks self-heal when deleted in cloud.
#[tokio::test]
async fn golden_outbox_behind_desktop_and_crash_recovery() {
    let cloud = setup_golden_outbox_cloud();
    let conn = fresh_db();
    let media_dir = TempDir::new().unwrap();
    let dev = "00000000-0000-0000-0000-000000000001";
    let key_list = cloud.key_state.content_key_list().unwrap();
    let summary = crate::sync::engine::SyncSummary::default();

    // (i2) Behind desktop: pull_clean = false means 0 applied
    let res_behind = run_outbox_import_cycle(
        cloud.provider.as_ref(),
        cloud.provider.as_ref(),
        dev,
        &key_list,
        std::collections::HashMap::new(),
        false,
        &summary,
        media_dir.path(),
        &conn,
        &NoopOutboxSink,
    )
    .await
    .unwrap();
    assert_eq!(
        res_behind.intents_applied, 0,
        "behind desktop evaluates zero intents"
    );

    // (i3) Crash mid-intent: populate local entries, insert pending record
    let engine = SyncEngine::new(cloud.provider.clone(), dev.to_string());
    engine
        .pull_remote(
            &conn,
            &cloud.engine_key,
            &cloud.key_state.snapshot_for_engine().unwrap(),
        )
        .await
        .unwrap();

    let edited_id = cloud.web_fixture["expected"]["edited_entry_id"]
        .as_str()
        .unwrap();
    let edited_path = format!("{}/outbox/{edited_id}.bin", cloud.web_device_id);
    let mut decided_map = BTreeMap::new();
    decided_map.insert(
        "title@10".to_string(),
        OutboxFieldDecision {
            field: "title".to_string(),
            change_seq: 10,
            decision: "applied".to_string(),
            decided_updated_at: 1000,
            reason: None,
        },
    );
    let pending_rec = db::queries::WebOutboxImportRecord {
        path: edited_path.clone(),
        revision: Some("rev-crash".to_string()),
        content_hash: "hash-crash".to_string(),
        outcome: "pending".to_string(),
        imported_at: 1000,
        last_applied_updated_at: None,
        post_import_fingerprint: None,
        decided_fields: Some(serde_json::to_string(&decided_map).unwrap()),
        pending_revision: Some("rev-crash".to_string()),
        pending_plan: Some(
            serde_json::to_string(&PendingPlan {
                is_create: false,
                local_before: 1700000000,
            })
            .unwrap(),
        ),
        created: false,
    };
    db::queries::outbox_import_record(&conn, &pending_rec).unwrap();

    // Next cycle resumes from pending row
    let _ = run_outbox_import_cycle(
        cloud.provider.as_ref(),
        cloud.provider.as_ref(),
        dev,
        &key_list,
        std::collections::HashMap::new(),
        true,
        &summary,
        media_dir.path(),
        &conn,
        &NoopOutboxSink,
    )
    .await
    .unwrap();

    let final_rec = db::queries::outbox_import_get(&conn, &edited_path)
        .unwrap()
        .unwrap();
    assert_eq!(
        final_rec.outcome, "applied",
        "resumed from pending to applied"
    );

    // (i4) Acks self-heal: delete {dev}/outbox-acks.bin, next cycle rewrites it
    let acks_cloud_path = format!("{dev}/outbox-acks.bin");
    cloud.delete_file(&acks_cloud_path).await.unwrap();

    let res_heal = run_outbox_import_cycle(
        cloud.provider.as_ref(),
        cloud.provider.as_ref(),
        dev,
        &key_list,
        std::collections::HashMap::new(),
        true,
        &summary,
        media_dir.path(),
        &conn,
        &NoopOutboxSink,
    )
    .await
    .unwrap();

    assert!(
        res_heal.acks_written,
        "acks file rewritten upon missing cloud file"
    );
    assert!(
        cloud.read_file(&acks_cloud_path).await.is_ok(),
        "acks file now exists again in cloud"
    );
}

/// (i5) Cross-desktop create window: both desktops import web-created entry before pushing;
/// (l) Discovery: zero outbox calls when desktops are unchanged and no web device.
#[tokio::test]
async fn golden_outbox_cross_desktop_create_and_discovery() {
    let cloud = setup_golden_outbox_cloud();
    let created_id = cloud.web_fixture["expected"]["created_entry_id"]
        .as_str()
        .unwrap();

    // Desktop A imports web-created E
    let media_dir_a = TempDir::new().unwrap();
    let conn_a = fresh_db();
    let dev_a = "00000000-0000-0000-0000-000000000001";
    run_desktop_sync_and_import(
        &cloud.provider,
        dev_a,
        &conn_a,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_a.path(),
    )
    .await;

    // Desktop B imports web-created E in the same window (before A pushes)
    let media_dir_b = TempDir::new().unwrap();
    let conn_b = fresh_db();
    let dev_b = "00000000-0000-0000-0000-000000000006";
    run_desktop_sync_and_import(
        &cloud.provider,
        dev_b,
        &conn_b,
        &cloud.key_state,
        &cloud.engine_key,
        media_dir_b.path(),
    )
    .await;

    // Both converge to one E with no refusal
    let row_a = db::get_entry_raw(&conn_a, created_id).unwrap().unwrap();
    let row_b = db::get_entry_raw(&conn_b, created_id).unwrap().unwrap();
    assert_eq!(row_a.id, row_b.id);
    assert_eq!(row_a.title, row_b.title);
    assert_eq!(row_a.content_text, row_b.content_text);

    // (l) Discovery: zero outbox calls when peers are unchanged and no web device
    let disc_dir = TempDir::new().unwrap();
    let disc_prov = Arc::new(fenced_provider(disc_dir.path(), 0));
    let dev1 = "00000000-0000-0000-0000-000000000001";
    let dev2 = "00000000-0000-0000-0000-000000000006";
    let slot1 = memlore_core::keyring_types::DeviceSlotV2 {
        version: memlore_core::keyring_types::KEYRING_V2_VERSION,
        device_id: dev1.to_string(),
        name: "Desktop 1".to_string(),
        created_at: 1000,
        last_seen_at: 1000,
    };
    let slot2 = memlore_core::keyring_types::DeviceSlotV2 {
        version: memlore_core::keyring_types::KEYRING_V2_VERSION,
        device_id: dev2.to_string(),
        name: "Desktop 2".to_string(),
        created_at: 1000,
        last_seen_at: 1000,
    };
    crate::sync::keyring_v2::io::write_device_slot(&*disc_prov, &slot1)
        .await
        .unwrap();
    crate::sync::keyring_v2::io::write_device_slot(&*disc_prov, &slot2)
        .await
        .unwrap();

    let counting = Arc::new(CountingOutboxProvider {
        inner: disc_prov.clone(),
        outbox_calls: std::sync::atomic::AtomicUsize::new(0),
    });

    let mut disc_summary = crate::sync::engine::SyncSummary::default();
    disc_summary.unchanged_peers = vec![dev2.to_string()];
    let disc_conn = fresh_db();
    let disc_media = TempDir::new().unwrap();
    let disc_key_list = cloud.key_state.content_key_list().unwrap();

    let _ = run_outbox_import_cycle(
        counting.as_ref(),
        counting.as_ref(),
        dev1,
        &disc_key_list,
        std::collections::HashMap::new(),
        true,
        &disc_summary,
        disc_media.path(),
        &disc_conn,
        &NoopOutboxSink,
    )
    .await
    .unwrap();

    assert_eq!(
        counting
            .outbox_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "zero list_files(Outbox) calls"
    );
}
