//! Golden parity tests: the real sync engine against `memlore_core::envelope`.
//!
//! Test-only. Every provider here is fenced (`with_recovery_fence`, mirroring
//! `commands/sync.rs`), so files live at `generations/g-N/<device>/...`, the
//! layout a web device must read and write. An unfenced provider would use the
//! flat root and hide a wrong path.

use super::engine::{SyncEngine, SyncTrigger};
use super::local_provider::LocalSyncProvider;
use super::media_sync::{fetch_media, fetch_media_thumbnail};
use super::metadata::{DeviceMetadata, EntryMetadata, SyncMediaItem, SyncedEntrySummary};
use crate::db;
use crate::utils::encryption::derive_sync_key;
use crate::EncryptionKeyState;
use memlore_core::envelope::{open_entry, open_media, seal_entry, seal_media, seal_thumb};
use memlore_core::key_state::ContentKeyList;
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
        }],
        journals: vec![],
        chats_present: false,
        memory_present: false,
        generated_at: meta.updated_at,
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
