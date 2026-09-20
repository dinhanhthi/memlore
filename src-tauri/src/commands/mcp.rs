use std::sync::Arc;

use rusqlite::Connection;
use tauri::State;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::ai::indexer::EntryIndexer;
use crate::ai::provider::settings_keys;
use crate::commands::entries::{
    create_entry_impl, maybe_detect_language_after_save,
    maybe_mark_entry_embedding_dirty_after_save, save_entry_content_impl,
    update_entry_emotion_impl, update_entry_impl, MAX_YJS_DOC_BYTES,
};
use crate::commands::tags::add_tag_to_entry_impl;
use crate::db::{self, LockedView, SearchFilters, TimeRangeFilter};
use crate::import_markdown::{append_markdown_to_doc, build_entry_yjs_from_markdown};
use crate::mcp::lifecycle::{mcp_status_snapshot, McpStatus};
use crate::mcp::server::McpServerManager;
use crate::{AppState, EncryptionKeyState};

/// Static not-found. Never interpolate entry body into the message (Risk 7).
const ENTRY_NOT_FOUND: &str = "Entry not found.";

/// Vault lock gate for every MCP tool. Mapped from `EncryptionKeyState::with_key`.
const MCP_LOCKED: &str = "Memlore is locked — unlock the app and retry.";

/// Live toggle choke point. Re-read on every tool call so turning the
/// setting off revokes already-accepted connections.
const MCP_DISABLED: &str = "MCP is not enabled.";

/// Same deniability as [`ENTRY_NOT_FOUND`]: do not say whether the journal
/// is missing, deleted, or invisible.
const JOURNAL_NOT_FOUND: &str = "Journal not found.";

/// Matches `import_markdown::PREVIEW_MAX_CHARS` — preview is always the head.
const PREVIEW_MAX_CHARS: usize = 200;

/// Journal row returned by [`list_journals_impl`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpJournal {
    pub id: String,
    pub name: String,
}

/// Search hit returned by [`search_entries_impl`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpSearchHit {
    pub id: String,
    pub title: Option<String>,
    pub date: i64,
    pub preview: Option<String>,
}

/// Entry body returned by [`get_entry_impl`]. `text` is plain `content_text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpEntry {
    pub id: String,
    pub title: Option<String>,
    pub date: i64,
    pub text: Option<String>,
    pub tags: Vec<String>,
    pub emotion: Option<String>,
}

/// Result of [`create_entry_impl_mcp`]. `journal_name` is the journal
/// actually used — required when `journal_id` was omitted and a fallback
/// ran, so the model can tell the user where the entry landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpCreatedEntry {
    pub id: String,
    pub journal_id: String,
    pub journal_name: String,
}

/// Result of [`append_to_entry_impl`]. `yjs_update` is `encode_diff_v1`
/// against the state vector captured before the append.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpAppendResult {
    pub id: String,
    pub yjs_update: Vec<u8>,
}

/// Result of [`set_entry_metadata_impl`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpMetadataResult {
    pub id: String,
}

pub(crate) fn list_journals_impl(conn: &Connection) -> Result<Vec<McpJournal>, String> {
    db::list_journals(conn, None)
        .map_err(|e| e.to_string())
        .map(|journals| {
            journals
                .into_iter()
                .map(|j| McpJournal {
                    id: j.id,
                    name: j.name,
                })
                .collect()
        })
}

pub(crate) fn search_entries_impl(
    conn: &Connection,
    query: &str,
    from: Option<i64>,
    to: Option<i64>,
) -> Result<Vec<McpSearchHit>, String> {
    let filters = search_time_filters(from, to);
    db::search_entries_with_locked_view(
        conn,
        query,
        filters.as_ref(),
        LockedView::Hidden,
        None,
        false,
    )
    .map_err(|e| e.to_string())
    .map(|hits| {
        hits.into_iter()
            .map(|hit| McpSearchHit {
                id: hit.id,
                title: hit.title,
                date: hit.entry_date,
                preview: hit.preview_text,
            })
            .collect()
    })
}

/// Map optional MCP `from`/`to` onto [`TimeRangeFilter`] the same way
/// existing search callers do: inclusive start, exclusive end, unix seconds.
fn search_time_filters(from: Option<i64>, to: Option<i64>) -> Option<SearchFilters> {
    match (from, to) {
        (None, None) => None,
        (from, to) => Some(SearchFilters {
            time_range: Some(TimeRangeFilter {
                from: from.unwrap_or(i64::MIN),
                to_exclusive: to.unwrap_or(i64::MAX),
            }),
            ..Default::default()
        }),
    }
}

pub(crate) fn get_entry_impl(conn: &Connection, id: &str) -> Result<McpEntry, String> {
    let entry = require_writable_entry(conn, id)?;
    let tags = db::get_tags_for_entry(conn, &entry.id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|tag| tag.name)
        .collect();
    Ok(McpEntry {
        id: entry.id,
        title: entry.title,
        date: entry.entry_date,
        text: entry.content_text,
        tags,
        emotion: entry.emotion,
    })
}

pub(crate) fn create_entry_impl_mcp(
    conn: &Connection,
    journal_id: Option<&str>,
    title: Option<&str>,
    markdown: &str,
    date: Option<i64>,
    tags: Option<&[String]>,
    emotion: Option<&str>,
) -> Result<McpCreatedEntry, String> {
    let (journal_id, journal_name) = resolve_create_journal(conn, journal_id)?;
    let tag_ids = resolve_existing_tag_ids(conn, tags)?;
    validate_emotion(emotion)?;

    let (yjs_doc, content_text, preview_text) = build_entry_yjs_from_markdown(markdown, |_| None);
    reject_oversized_yjs(yjs_doc.len())?;

    let entry_date = date.unwrap_or_else(|| chrono::Utc::now().timestamp());
    let entry = create_entry_impl(
        conn,
        &journal_id,
        title,
        Some(&content_text),
        Some(&preview_text),
        entry_date,
    )?;
    save_entry_content_impl(conn, &entry.id, &yjs_doc, &content_text, &preview_text)?;
    attach_tags(conn, &entry.id, &tag_ids)?;
    if emotion.is_some() {
        update_entry_emotion_impl(conn, &entry.id, emotion)?;
    }

    Ok(McpCreatedEntry {
        id: entry.id,
        journal_id,
        journal_name,
    })
}

pub(crate) fn append_to_entry_impl(
    conn: &Connection,
    id: &str,
    markdown: &str,
) -> Result<McpAppendResult, String> {
    let entry = require_writable_entry(conn, id)?;
    let existing_blob = db::get_entry_content(conn, id).map_err(|e| e.to_string())?;
    let doc = load_yjs_doc(existing_blob.as_deref())?;
    let sv_before = doc.transact().state_vector();
    let appended_plain = append_markdown_to_doc(&doc, markdown, |_| None);
    let full_state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    reject_oversized_yjs(full_state.len())?;

    let existing_text = entry.content_text.as_deref().unwrap_or("");
    let content_text = format!("{existing_text}\n{appended_plain}");
    let preview_text: String = content_text.chars().take(PREVIEW_MAX_CHARS).collect();
    save_entry_content_impl(conn, id, &full_state, &content_text, &preview_text)?;

    let yjs_update = doc.transact().encode_diff_v1(&sv_before);
    Ok(McpAppendResult {
        id: entry.id,
        yjs_update,
    })
}

pub(crate) fn set_entry_metadata_impl(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    tags: Option<&[String]>,
    emotion: Option<&str>,
) -> Result<McpMetadataResult, String> {
    let entry = require_writable_entry(conn, id)?;
    let tag_ids = resolve_existing_tag_ids(conn, tags)?;
    validate_emotion(emotion)?;

    if title.is_some() {
        update_entry_impl(conn, &entry.id, title, None, None)?;
    }
    if emotion.is_some() {
        update_entry_emotion_impl(conn, &entry.id, emotion)?;
    }
    attach_tags(conn, &entry.id, &tag_ids)?;

    Ok(McpMetadataResult { id: entry.id })
}

/// Same gate as the read path: invisible/deleted → not-found; locked →
/// not-found even when `ai_embed_include_protected` is on.
fn require_writable_entry(conn: &Connection, id: &str) -> Result<db::Entry, String> {
    let entry = db::get_entry_for_provider(conn, id).map_err(|e| e.to_string())?;
    let Some(entry) = entry else {
        return Err(ENTRY_NOT_FOUND.to_string());
    };
    if entry.is_locked {
        return Err(ENTRY_NOT_FOUND.to_string());
    }
    Ok(entry)
}

fn resolve_create_journal(
    conn: &Connection,
    journal_id: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(id) = journal_id {
        return visible_journal(conn, id)?.ok_or_else(|| JOURNAL_NOT_FOUND.to_string());
    }
    if let Some(default_id) =
        db::get_setting(conn, settings_keys::MCP_DEFAULT_JOURNAL_ID).map_err(|e| e.to_string())?
    {
        if let Some(found) = visible_journal(conn, &default_id)? {
            return Ok(found);
        }
    }
    let journals = db::list_journals(conn, None).map_err(|e| e.to_string())?;
    journals
        .into_iter()
        .next()
        .map(|j| (j.id, j.name))
        .ok_or_else(|| JOURNAL_NOT_FOUND.to_string())
}

fn visible_journal(conn: &Connection, id: &str) -> Result<Option<(String, String)>, String> {
    match db::get_journal(conn, id).map_err(|e| e.to_string())? {
        Some(j) if !j.is_deleted && !j.is_invisible => Ok(Some((j.id, j.name))),
        _ => Ok(None),
    }
}

/// Look up existing visible tags by name. Never creates a tag.
fn resolve_existing_tag_ids(
    conn: &Connection,
    tags: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let Some(names) = tags.filter(|names| !names.is_empty()) else {
        return Ok(Vec::new());
    };
    let existing = db::list_tags(conn, None).map_err(|e| e.to_string())?;
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let trimmed = name.trim();
        let found = existing.iter().find(|tag| tag.name == trimmed);
        match found {
            Some(tag) => ids.push(tag.id.clone()),
            None => return Err(format!("Unknown tag: {trimmed}")),
        }
    }
    Ok(ids)
}

fn attach_tags(conn: &Connection, entry_id: &str, tag_ids: &[String]) -> Result<(), String> {
    for tag_id in tag_ids {
        add_tag_to_entry_impl(conn, entry_id, tag_id)?;
    }
    Ok(())
}

fn validate_emotion(emotion: Option<&str>) -> Result<(), String> {
    match emotion {
        None | Some("bad") | Some("neutral") | Some("good") => Ok(()),
        Some(value) => Err(format!("invalid emotion: {value}")),
    }
}

fn reject_oversized_yjs(len: usize) -> Result<(), String> {
    if len > MAX_YJS_DOC_BYTES {
        return Err("Yjs document exceeds maximum allowed size (10 MiB)".to_string());
    }
    Ok(())
}

fn load_yjs_doc(blob: Option<&[u8]>) -> Result<Doc, String> {
    let doc = Doc::new();
    if let Some(bytes) = blob.filter(|b| !b.is_empty()) {
        let update = Update::decode_v1(bytes).map_err(|e| e.to_string())?;
        let mut txn = doc.transact_mut();
        txn.apply_update(update).map_err(|e| e.to_string())?;
    }
    Ok(doc)
}

/// Re-read the Settings toggle. Unlinking the socket later does not close
/// already-accepted connections, so this is the revoke check.
fn require_mcp_enabled(state: &AppState) -> Result<(), String> {
    state.with_conn(|conn| {
        let enabled = db::get_setting(conn, settings_keys::MCP_SERVER_ENABLED)
            .map_err(|e| e.to_string())?
            .as_deref()
            == Some("true");
        if enabled {
            Ok(())
        } else {
            Err(MCP_DISABLED.to_string())
        }
    })
}

fn map_lock_error(err: String) -> String {
    if err == "Encryption key not initialized — app is locked" {
        MCP_LOCKED.to_string()
    } else {
        err
    }
}

/// Toggle check → `with_key` → `AppState` lock → inner work. Guards drop
/// before this returns so callers can run post-save hooks outside the key lock.
fn mcp_gated<R>(
    state: &AppState,
    key_state: &EncryptionKeyState,
    f: impl FnOnce(&Connection) -> Result<R, String>,
) -> Result<R, String> {
    require_mcp_enabled(state)?;
    key_state
        .with_key(|_key| {
            let conn = state.lock()?;
            f(&conn)
        })
        .map_err(map_lock_error)
}

fn run_post_save_hooks(
    state: &AppState,
    indexer: &EntryIndexer,
    entry_id: &str,
) -> Result<(), String> {
    {
        let conn = state.lock()?;
        maybe_detect_language_after_save(&conn, entry_id);
    }
    maybe_mark_entry_embedding_dirty_after_save(state, indexer, entry_id);
    Ok(())
}

pub(crate) fn mcp_list_journals(
    state: &AppState,
    key_state: &EncryptionKeyState,
) -> Result<Vec<McpJournal>, String> {
    mcp_gated(state, key_state, list_journals_impl)
}

pub(crate) fn mcp_search_entries(
    state: &AppState,
    key_state: &EncryptionKeyState,
    query: &str,
    from: Option<i64>,
    to: Option<i64>,
) -> Result<Vec<McpSearchHit>, String> {
    mcp_gated(state, key_state, |conn| {
        search_entries_impl(conn, query, from, to)
    })
}

pub(crate) fn mcp_get_entry(
    state: &AppState,
    key_state: &EncryptionKeyState,
    id: &str,
) -> Result<McpEntry, String> {
    mcp_gated(state, key_state, |conn| get_entry_impl(conn, id))
}

pub(crate) fn mcp_create_entry(
    state: &AppState,
    key_state: &EncryptionKeyState,
    indexer: &EntryIndexer,
    journal_id: Option<&str>,
    title: Option<&str>,
    markdown: &str,
    date: Option<i64>,
    tags: Option<&[String]>,
    emotion: Option<&str>,
) -> Result<McpCreatedEntry, String> {
    let created = mcp_gated(state, key_state, |conn| {
        create_entry_impl_mcp(conn, journal_id, title, markdown, date, tags, emotion)
    })?;
    run_post_save_hooks(state, indexer, &created.id)?;
    Ok(created)
}

pub(crate) fn mcp_append_to_entry(
    state: &AppState,
    key_state: &EncryptionKeyState,
    indexer: &EntryIndexer,
    id: &str,
    markdown: &str,
) -> Result<McpAppendResult, String> {
    let appended = mcp_gated(state, key_state, |conn| {
        append_to_entry_impl(conn, id, markdown)
    })?;
    run_post_save_hooks(state, indexer, &appended.id)?;
    Ok(appended)
}

pub(crate) fn mcp_set_entry_metadata(
    state: &AppState,
    key_state: &EncryptionKeyState,
    indexer: &EntryIndexer,
    id: &str,
    title: Option<&str>,
    tags: Option<&[String]>,
    emotion: Option<&str>,
) -> Result<McpMetadataResult, String> {
    let updated = mcp_gated(state, key_state, |conn| {
        set_entry_metadata_impl(conn, id, title, tags, emotion)
    })?;
    run_post_save_hooks(state, indexer, &updated.id)?;
    Ok(updated)
}

/// `{ running, socketPath, binaryPath }`. `binaryPath` is
/// `std::env::current_exe()` — never a hardcoded `/Applications/…` path.
#[tauri::command]
pub fn mcp_status(manager: State<'_, Arc<McpServerManager>>) -> Result<McpStatus, String> {
    Ok(mcp_status_snapshot(&manager))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::settings_keys;
    use crate::db::{self, schema::migrate, CreateEntryParams};
    use crate::utils::encryption::{derive_encryption_key, SALT_SIZE};

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    fn make_journal(conn: &Connection, name: &str) -> String {
        db::create_journal(conn, name, None).unwrap().id
    }

    fn make_entry(
        conn: &Connection,
        journal_id: &str,
        title: &str,
        body: &str,
        preview: &str,
        entry_date: i64,
    ) -> String {
        db::create_entry(
            conn,
            CreateEntryParams {
                journal_id,
                title: Some(title),
                content_text: Some(body),
                preview_text: Some(preview),
                entry_date,
            },
        )
        .unwrap()
        .id
    }

    fn search_ids(conn: &Connection, query: &str) -> Vec<String> {
        search_entries_impl(conn, query, None, None)
            .unwrap()
            .into_iter()
            .map(|hit| hit.id)
            .collect()
    }

    fn assert_not_found(err: &str) {
        assert_eq!(err, "Entry not found.");
    }

    #[test]
    fn list_journals_returns_visible_journals() {
        let conn = setup();
        let id = make_journal(&conn, "Travel");
        let listed = list_journals_impl(&conn).unwrap();
        assert!(
            listed.iter().any(|j| j.id == id && j.name == "Travel"),
            "created journal must appear as {{id, name}}"
        );
        assert!(
            listed.iter().any(|j| j.name == "My Journal"),
            "migrate() default journal must remain listed"
        );
    }

    #[test]
    fn visible_unlocked_entry_is_returned() {
        let conn = setup();
        let journal_id = make_journal(&conn, "Daily");
        let entry_id = make_entry(
            &conn,
            &journal_id,
            "Morning",
            "mcpvisibleunique walked the dog",
            "walked the dog",
            1_700_000_000,
        );
        let tag = db::create_tag(&conn, "walk", None).unwrap();
        db::add_tag_to_entry(&conn, &entry_id, &tag.id).unwrap();
        db::update_entry_emotion(&conn, &entry_id, Some("good")).unwrap();

        let hits = search_entries_impl(&conn, "mcpvisibleunique", None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, entry_id);
        assert_eq!(hits[0].title.as_deref(), Some("Morning"));
        assert_eq!(hits[0].date, 1_700_000_000);
        assert_eq!(hits[0].preview.as_deref(), Some("walked the dog"));

        let entry = get_entry_impl(&conn, &entry_id).unwrap();
        assert_eq!(entry.id, entry_id);
        assert_eq!(entry.title.as_deref(), Some("Morning"));
        assert_eq!(entry.date, 1_700_000_000);
        assert_eq!(
            entry.text.as_deref(),
            Some("mcpvisibleunique walked the dog")
        );
        assert_eq!(entry.tags, vec!["walk".to_string()]);
        assert_eq!(entry.emotion.as_deref(), Some("good"));
    }

    #[test]
    fn invisible_entry_is_absent_from_search_and_get() {
        let conn = setup();
        let journal_id = make_journal(&conn, "Daily");
        let visible_id = make_entry(
            &conn,
            &journal_id,
            "Visible",
            "mcpsharedtoken visible body",
            "visible preview",
            100,
        );
        let invisible_id = make_entry(
            &conn,
            &journal_id,
            "Hidden",
            "mcpsharedtoken mcpinvisibleunique",
            "hidden preview",
            200,
        );
        db::set_entry_invisible(&conn, &invisible_id, true, Some("test-vault")).unwrap();

        let ids = search_ids(&conn, "mcpsharedtoken");
        assert_eq!(ids, vec![visible_id]);

        let err = get_entry_impl(&conn, &invisible_id).unwrap_err();
        assert_not_found(&err);
        assert!(
            !err.contains("mcpinvisibleunique"),
            "not-found must not echo the invisible entry body"
        );
    }

    #[test]
    fn locked_entry_is_absent_even_when_embed_include_protected() {
        let conn = setup();
        db::set_setting(&conn, settings_keys::EMBED_INCLUDE_PROTECTED, "true").unwrap();

        let journal_id = make_journal(&conn, "Daily");
        let visible_id = make_entry(
            &conn,
            &journal_id,
            "Visible",
            "mcpsharedtoken visible body",
            "visible preview",
            100,
        );
        let locked_id = make_entry(
            &conn,
            &journal_id,
            "Locked",
            "mcpsharedtoken mcplockedunique",
            "locked preview",
            200,
        );
        db::set_entry_locked(&conn, &locked_id, true).unwrap();

        let ids = search_ids(&conn, "mcpsharedtoken");
        assert_eq!(ids, vec![visible_id]);

        let err = get_entry_impl(&conn, &locked_id).unwrap_err();
        assert_not_found(&err);
        assert!(
            !err.contains("mcplockedunique"),
            "not-found must not echo the locked entry body"
        );
    }

    #[test]
    fn soft_deleted_entry_is_absent_from_search_and_get() {
        let conn = setup();
        let journal_id = make_journal(&conn, "Daily");
        let visible_id = make_entry(
            &conn,
            &journal_id,
            "Visible",
            "mcpsharedtoken visible body",
            "visible preview",
            100,
        );
        let deleted_id = make_entry(
            &conn,
            &journal_id,
            "Gone",
            "mcpsharedtoken mcpdeletedunique",
            "deleted preview",
            200,
        );
        db::soft_delete_entry(&conn, &deleted_id).unwrap();

        let ids = search_ids(&conn, "mcpsharedtoken");
        assert_eq!(ids, vec![visible_id]);

        let err = get_entry_impl(&conn, &deleted_id).unwrap_err();
        assert_not_found(&err);
        assert!(
            !err.contains("mcpdeletedunique"),
            "not-found must not echo the deleted entry body"
        );
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let conn = setup();
        let journal_id = make_journal(&conn, "Daily");
        make_entry(
            &conn,
            &journal_id,
            "Morning",
            "mcpvisibleunique walked the dog",
            "walked the dog",
            1_700_000_000,
        );

        assert!(search_entries_impl(&conn, "", None, None)
            .unwrap()
            .is_empty());
        assert!(search_entries_impl(&conn, "   ", None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unknown_id_is_not_found() {
        let conn = setup();
        let err = get_entry_impl(&conn, "missing-entry-id").unwrap_err();
        assert_not_found(&err);
    }

    fn sync_row(conn: &Connection, entry_id: &str) -> (i64, String) {
        conn.query_row(
            "SELECT local_version, sync_status FROM sync_state WHERE entry_id = ?1",
            [entry_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("sync_state row")
    }

    fn assert_pending_bumped(conn: &Connection, entry_id: &str, previous: Option<i64>) -> i64 {
        let (version, status) = sync_row(conn, entry_id);
        assert_eq!(status, "pending", "write must leave sync_status pending");
        if let Some(prev) = previous {
            assert!(
                version > prev,
                "local_version must bump (was {prev}, now {version})"
            );
        } else {
            assert!(version >= 1, "first write must create a pending version");
        }
        version
    }

    fn decode_yjs(bytes: &[u8]) -> yrs::Doc {
        use yrs::updates::decoder::Decode;
        use yrs::{Transact, Update};
        let update = Update::decode_v1(bytes).expect("decode yjs");
        let doc = yrs::Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).expect("apply yjs");
        }
        doc
    }

    fn fragment_plain(doc: &yrs::Doc) -> String {
        use yrs::types::xml::XmlOut;
        use yrs::{GetString, Transact, XmlFragment};
        let fragment = doc.get_or_insert_xml_fragment("default");
        let txn = doc.transact();
        fragment
            .children(&txn)
            .map(|child| match child {
                XmlOut::Element(el) => el
                    .children(&txn)
                    .filter_map(|inner| match inner {
                        XmlOut::Text(text) => Some(text.get_string(&txn)),
                        _ => None,
                    })
                    .collect::<String>(),
                XmlOut::Text(text) => text.get_string(&txn),
                XmlOut::Fragment(_) => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn create_visible_mcp_entry(conn: &Connection, body: &str) -> McpCreatedEntry {
        let journal_id = make_journal(conn, "Daily");
        create_entry_impl_mcp(
            conn,
            Some(&journal_id),
            Some("Seed"),
            body,
            Some(1_700_000_000),
            None,
            None,
        )
        .expect("create visible mcp entry")
    }

    #[test]
    fn writes_bump_sync_state_to_pending() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "first body");
        let after_create = assert_pending_bumped(&conn, &created.id, None);

        append_to_entry_impl(&conn, &created.id, "second body").unwrap();
        let after_append = assert_pending_bumped(&conn, &created.id, Some(after_create));

        set_entry_metadata_impl(&conn, &created.id, Some("Renamed"), None, Some("good")).unwrap();
        assert_pending_bumped(&conn, &created.id, Some(after_append));
    }

    #[test]
    fn append_never_shortens_content_text() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "keep this original body");
        let before = db::get_entry(&conn, &created.id)
            .unwrap()
            .unwrap()
            .content_text
            .unwrap_or_default();

        append_to_entry_impl(&conn, &created.id, "and then this addition").unwrap();

        let after = db::get_entry(&conn, &created.id)
            .unwrap()
            .unwrap()
            .content_text
            .unwrap_or_default();
        assert!(
            after.len() >= before.len(),
            "append must not shorten content_text (before {} chars, after {} chars)",
            before.len(),
            after.len()
        );
        assert!(
            after.starts_with(&before),
            "append must keep the original content_text as a prefix"
        );
    }

    #[test]
    fn append_delta_applied_to_original_blob_matches_persisted_text() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "original paragraph");
        let original_blob = db::get_entry_content(&conn, &created.id)
            .unwrap()
            .expect("created entry stores a yjs blob");

        let appended = append_to_entry_impl(&conn, &created.id, "appended paragraph").unwrap();
        let persisted_blob = db::get_entry_content(&conn, &created.id)
            .unwrap()
            .expect("append persists a full yjs blob");

        let replica = decode_yjs(&original_blob);
        {
            use yrs::updates::decoder::Decode;
            use yrs::{Transact, Update};
            let mut txn = replica.transact_mut();
            txn.apply_update(Update::decode_v1(&appended.yjs_update).expect("decode delta"))
                .expect("apply delta");
        }
        let persisted = decode_yjs(&persisted_blob);
        assert_eq!(
            fragment_plain(&replica),
            fragment_plain(&persisted),
            "delta applied to the original blob must match the persisted full state"
        );
    }

    #[test]
    fn set_entry_metadata_unknown_tag_errors_and_writes_nothing() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "body");
        let before = db::get_entry(&conn, &created.id).unwrap().unwrap();
        let before_tags: Vec<String> = db::get_tags_for_entry(&conn, &created.id)
            .unwrap()
            .into_iter()
            .map(|tag| tag.name)
            .collect();
        let before_sync = sync_row(&conn, &created.id);

        let err = set_entry_metadata_impl(
            &conn,
            &created.id,
            Some("Changed title"),
            Some(&[String::from("no-such-tag")]),
            Some("good"),
        )
        .unwrap_err();
        assert!(
            err.contains("no-such-tag"),
            "unknown tag error must name the tag, got {err}"
        );

        let after = db::get_entry(&conn, &created.id).unwrap().unwrap();
        assert_eq!(after.title, before.title);
        assert_eq!(after.emotion, before.emotion);
        assert_eq!(after.updated_at, before.updated_at);
        let after_tags: Vec<String> = db::get_tags_for_entry(&conn, &created.id)
            .unwrap()
            .into_iter()
            .map(|tag| tag.name)
            .collect();
        assert_eq!(after_tags, before_tags);
        assert_eq!(sync_row(&conn, &created.id), before_sync);
    }

    #[test]
    fn omitted_journal_id_with_stale_default_falls_back() {
        let conn = setup();
        db::set_setting(&conn, settings_keys::MCP_DEFAULT_JOURNAL_ID, "stale-id").unwrap();
        let fallback = list_journals_impl(&conn)
            .unwrap()
            .into_iter()
            .next()
            .expect("migrate() seeds a visible journal");

        let created = create_entry_impl_mcp(
            &conn,
            None,
            Some("Fallback"),
            "used the fallback journal",
            Some(1_700_000_000),
            None,
            None,
        )
        .unwrap();

        assert_eq!(created.journal_id, fallback.id);
        assert_eq!(created.journal_name, fallback.name);
        let stored = db::get_entry(&conn, &created.id).unwrap().unwrap();
        assert_eq!(stored.journal_id, fallback.id);
    }

    #[test]
    fn append_on_locked_entry_errors_and_writes_nothing() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "locked body");
        db::set_entry_locked(&conn, &created.id, true).unwrap();
        let before = db::get_entry(&conn, &created.id).unwrap().unwrap();
        let blob_before = db::get_entry_content(&conn, &created.id).unwrap();

        let err = append_to_entry_impl(&conn, &created.id, "must not land").unwrap_err();
        assert_not_found(&err);

        let after = db::get_entry(&conn, &created.id).unwrap().unwrap();
        assert_eq!(after.content_text, before.content_text);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(
            db::get_entry_content(&conn, &created.id).unwrap(),
            blob_before
        );
    }

    #[test]
    fn append_on_invisible_entry_errors_and_writes_nothing() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "hidden body");
        db::set_entry_invisible(&conn, &created.id, true, Some("test-vault")).unwrap();
        let before = db::get_entry(&conn, &created.id).unwrap().unwrap();
        let blob_before = db::get_entry_content(&conn, &created.id).unwrap();

        let err = append_to_entry_impl(&conn, &created.id, "must not land").unwrap_err();
        assert_not_found(&err);

        let after = db::get_entry(&conn, &created.id).unwrap().unwrap();
        assert_eq!(after.content_text, before.content_text);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(
            db::get_entry_content(&conn, &created.id).unwrap(),
            blob_before
        );
    }

    #[test]
    fn set_entry_metadata_on_locked_entry_errors_and_writes_nothing() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "locked meta");
        db::set_entry_locked(&conn, &created.id, true).unwrap();
        let before = db::get_entry(&conn, &created.id).unwrap().unwrap();

        let err = set_entry_metadata_impl(&conn, &created.id, Some("Nope"), None, Some("bad"))
            .unwrap_err();
        assert_not_found(&err);

        let after = db::get_entry(&conn, &created.id).unwrap().unwrap();
        assert_eq!(after.title, before.title);
        assert_eq!(after.emotion, before.emotion);
        assert_eq!(after.updated_at, before.updated_at);
    }

    #[test]
    fn set_entry_metadata_on_invisible_entry_errors_and_writes_nothing() {
        let conn = setup();
        let created = create_visible_mcp_entry(&conn, "hidden meta");
        db::set_entry_invisible(&conn, &created.id, true, Some("test-vault")).unwrap();
        let before = db::get_entry(&conn, &created.id).unwrap().unwrap();

        let err = set_entry_metadata_impl(&conn, &created.id, Some("Nope"), None, Some("bad"))
            .unwrap_err();
        assert_not_found(&err);

        let after = db::get_entry(&conn, &created.id).unwrap().unwrap();
        assert_eq!(after.title, before.title);
        assert_eq!(after.emotion, before.emotion);
        assert_eq!(after.updated_at, before.updated_at);
    }

    // ── Task 2.3: lock gate, live toggle, post-save hooks ─────────────────

    fn setup_state() -> AppState {
        AppState::new(setup())
    }

    fn unlocked_key() -> EncryptionKeyState {
        let ks = EncryptionKeyState::new();
        let key = derive_encryption_key("test-password-1234", &[9u8; SALT_SIZE]).unwrap();
        ks.set_key(key).unwrap();
        ks
    }

    fn enable_mcp(state: &AppState) {
        let conn = state.lock().unwrap();
        db::set_setting(&conn, settings_keys::MCP_SERVER_ENABLED, "true").unwrap();
    }

    fn seed_gated_fixture(state: &AppState) -> (String, db::Entry, (i64, String)) {
        let conn = state.lock().unwrap();
        let created = create_visible_mcp_entry(&conn, "gated-seed-body-unique");
        let entry = db::get_entry(&conn, &created.id).unwrap().unwrap();
        let sync = sync_row(&conn, &created.id);
        (created.id, entry, sync)
    }

    fn entry_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))
            .unwrap()
    }

    fn embedding_job_count(conn: &Connection, entry_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM entry_embedding_jobs WHERE entry_id = ?1",
            [entry_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn invoke_all_gated(
        state: &AppState,
        key_state: &EncryptionKeyState,
        indexer: &EntryIndexer,
        seed_id: &str,
    ) -> [(&'static str, Result<(), String>); 6] {
        [
            (
                "list_journals",
                mcp_list_journals(state, key_state).map(|_| ()),
            ),
            (
                "search_entries",
                mcp_search_entries(state, key_state, "gated-seed-body-unique", None, None)
                    .map(|_| ()),
            ),
            (
                "get_entry",
                mcp_get_entry(state, key_state, seed_id).map(|_| ()),
            ),
            (
                "create_entry",
                mcp_create_entry(
                    state,
                    key_state,
                    indexer,
                    None,
                    Some("Must not land"),
                    "must-not-write-locked-or-disabled",
                    Some(1_700_000_001),
                    None,
                    None,
                )
                .map(|_| ()),
            ),
            (
                "append_to_entry",
                mcp_append_to_entry(state, key_state, indexer, seed_id, "must not append")
                    .map(|_| ()),
            ),
            (
                "set_entry_metadata",
                mcp_set_entry_metadata(
                    state,
                    key_state,
                    indexer,
                    seed_id,
                    Some("Must not rename"),
                    None,
                    Some("bad"),
                )
                .map(|_| ()),
            ),
        ]
    }

    fn assert_zero_writes(
        state: &AppState,
        seed_id: &str,
        before: &db::Entry,
        before_sync: (i64, String),
        entries_before: i64,
    ) {
        let conn = state.lock().unwrap();
        assert_eq!(
            entry_count(&conn),
            entries_before,
            "gated refuse must insert zero entries"
        );
        let after = db::get_entry(&conn, seed_id).unwrap().unwrap();
        assert_eq!(after.title, before.title);
        assert_eq!(after.content_text, before.content_text);
        assert_eq!(after.emotion, before.emotion);
        assert_eq!(after.updated_at, before.updated_at);
        assert_eq!(sync_row(&conn, seed_id), before_sync);
    }

    #[test]
    fn locked_key_refuses_all_six_tools_and_writes_nothing() {
        let state = setup_state();
        enable_mcp(&state);
        let (seed_id, before, before_sync) = seed_gated_fixture(&state);
        let entries_before = {
            let conn = state.lock().unwrap();
            entry_count(&conn)
        };
        let locked = EncryptionKeyState::new();
        let indexer = EntryIndexer::with_stub();

        for (name, result) in invoke_all_gated(&state, &locked, &indexer, &seed_id) {
            let err = result.expect_err(name);
            assert_eq!(
                err, MCP_LOCKED,
                "{name} must return the locked error, got {err}"
            );
            assert!(
                !err.contains("gated-seed-body-unique"),
                "{name} must not echo journal text"
            );
        }

        assert_zero_writes(&state, &seed_id, &before, before_sync, entries_before);
    }

    #[test]
    fn mcp_disabled_unset_refuses_all_six_tools() {
        let state = setup_state();
        let (seed_id, before, before_sync) = seed_gated_fixture(&state);
        let entries_before = {
            let conn = state.lock().unwrap();
            assert!(
                db::get_setting(&conn, settings_keys::MCP_SERVER_ENABLED)
                    .unwrap()
                    .is_none(),
                "fixture must leave the toggle unset"
            );
            entry_count(&conn)
        };
        let key = unlocked_key();
        let indexer = EntryIndexer::with_stub();

        for (name, result) in invoke_all_gated(&state, &key, &indexer, &seed_id) {
            let err = result.expect_err(name);
            assert_eq!(
                err, MCP_DISABLED,
                "{name} must refuse when MCP is unset, got {err}"
            );
            assert!(
                !err.contains("gated-seed-body-unique"),
                "{name} must not echo journal text"
            );
        }

        assert_zero_writes(&state, &seed_id, &before, before_sync, entries_before);
    }

    #[test]
    fn mcp_disabled_false_refuses_all_six_tools() {
        let state = setup_state();
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, settings_keys::MCP_SERVER_ENABLED, "false").unwrap();
        }
        let (seed_id, before, before_sync) = seed_gated_fixture(&state);
        let entries_before = {
            let conn = state.lock().unwrap();
            entry_count(&conn)
        };
        let key = unlocked_key();
        let indexer = EntryIndexer::with_stub();

        for (name, result) in invoke_all_gated(&state, &key, &indexer, &seed_id) {
            let err = result.expect_err(name);
            assert_eq!(
                err, MCP_DISABLED,
                "{name} must refuse when MCP is false, got {err}"
            );
            assert!(
                !err.contains("gated-seed-body-unique"),
                "{name} must not echo journal text"
            );
        }

        assert_zero_writes(&state, &seed_id, &before, before_sync, entries_before);
    }

    #[test]
    fn mcp_create_lands_in_embedding_dirty_queue() {
        let state = setup_state();
        enable_mcp(&state);
        {
            let conn = state.lock().unwrap();
            db::set_setting(&conn, "ai_semantic_search_enabled", "true").unwrap();
            db::set_setting(&conn, "ai_embed_provider", "openai").unwrap();
        }
        let journal_id = {
            let conn = state.lock().unwrap();
            make_journal(&conn, "Daily")
        };
        let key = unlocked_key();
        let indexer = EntryIndexer::with_stub();

        let created = mcp_create_entry(
            &state,
            &key,
            &indexer,
            Some(&journal_id),
            Some("Embed me"),
            "MCP created journal entry for embedding dirty queue.",
            Some(1_700_000_000),
            None,
            None,
        )
        .expect("unlocked + MCP on must create");

        let conn = state.lock().unwrap();
        assert_eq!(
            embedding_job_count(&conn, &created.id),
            1,
            "MCP create must enqueue the same dirty job a UI create would"
        );
    }
}
