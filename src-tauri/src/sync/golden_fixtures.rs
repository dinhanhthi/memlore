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
