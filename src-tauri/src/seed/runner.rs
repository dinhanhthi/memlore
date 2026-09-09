//! Demo seed orchestration via production create paths.
//!
//! Sequence mirrors real user flow: tags → journals → entries (media first,
//! then Yjs body, then emotion/tags/favorite/location/weather). Mutation
//! helpers from the command layer (`*_impl`) keep `sync_state` pending the
//! same way production commands do.
//!
//! **One-shot:** if any live entries already exist in `[Demo]` journals, the
//! run is rejected. Delete those journals to seed again.
//! **Bodies:** curated catalog stories (personal narratives, ~80% Vietnamese /
//! ~20% English). Optional Wikipedia overrides via [`SeedOptions::wiki_texts`]
//! remain for tests / tooling.

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

use crate::commands::entries::{
    create_entry_impl, save_entry_content_impl, toggle_favorite_impl, update_entry_emotion_impl,
    update_entry_location_impl, update_entry_weather_impl,
};
use crate::commands::media::save_media_to_media_dir;
use crate::commands::tags::add_tag_to_entry_impl;
use crate::db;
use crate::db::Journal;
use crate::seed::catalog::{demo_entries, demo_journals, demo_tags};
use crate::seed::media_synth::{fetch_picsum_jpeg, synth_text_file, synth_wav_tone};
use crate::seed::wiki::WikiEntryText;
use crate::seed::yjs_builder::build_entry_yjs;

/// Days each seed generation is shifted further into the past so re-run
/// entry dates do not land on the same calendar days as earlier batches.
/// Must exceed the catalog day_offset span (~120 days) so batches do not overlap.
const GENERATION_DAY_SPAN: i32 = 130;

/// Counts + ids returned to the frontend after a seed run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedDemoResult {
    pub journals_created: u32,
    pub entries_created: u32,
    pub tags_created: u32,
    pub media_created: u32,
    pub journal_ids: Vec<String>,
    pub run_suffix: String,
    /// 0 = first full batch into these journals; higher = re-run batch index.
    pub generation: u32,
}

/// Options for [`run_seed_demo`]. Tests inject a fixed clock and offline image
/// bytes so the suite never hits the network.
pub struct SeedOptions {
    /// Fixed clock for tests; default = now unix seconds.
    pub now_unix: Option<i64>,
    /// Override image fetch (picsum seed). Tests inject `minimal_jpeg_bytes`.
    /// Signature: `(picsum_seed: u32) -> Result<Vec<u8>, String>`.
    pub fetch_image: Option<Box<dyn Fn(u32) -> Result<Vec<u8>, String> + Send + Sync>>,
    /// Optional run suffix override (default: `now_unix` as string).
    pub run_suffix: Option<String>,
    /// Index-aligned Wikipedia titles/bodies (from prefetch). `None` slots
    /// use the static catalog entry. When the whole field is `None`, all
    /// entries use the catalog (offline / unit tests).
    pub wiki_texts: Option<Vec<Option<WikiEntryText>>>,
}

impl Default for SeedOptions {
    fn default() -> Self {
        Self {
            now_unix: None,
            fetch_image: None,
            run_suffix: None,
            wiki_texts: None,
        }
    }
}

fn resolve_now_unix(opts: &SeedOptions) -> i64 {
    opts.now_unix.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    })
}

/// Picsum seed formula — must match `commands/seed_demo.rs` prefetch so cache hits.
///
/// `generation` shifts the seed space so re-runs download different photos.
pub fn picsum_seed_for(entry_idx: usize, photo_i: u8, generation: u32) -> u32 {
    (entry_idx as u32)
        .wrapping_mul(31)
        .wrapping_add(u32::from(photo_i))
        .wrapping_add(1)
        .wrapping_add(generation.wrapping_mul(10_000))
}

/// Find an existing demo journal for a catalog name.
///
/// Matches stable names (`[Demo] Personal`) and legacy seed names
/// (`[Demo] Personal · <suffix>` from earlier additive runs).
fn find_demo_journal(journals: &[Journal], catalog_name: &str) -> Option<Journal> {
    if let Some(j) = journals.iter().find(|j| j.name == catalog_name) {
        return Some(j.clone());
    }
    let prefix = format!("{catalog_name} · ");
    journals
        .iter()
        .find(|j| j.name.starts_with(&prefix))
        .cloned()
}

/// Collect ids of existing demo journals (stable + legacy suffixed names).
fn demo_journal_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let journals = db::list_journals(conn, None).map_err(|e| e.to_string())?;
    let mut journal_ids: Vec<String> = Vec::new();
    for catalog in demo_journals() {
        if let Some(j) = find_demo_journal(&journals, catalog.name) {
            journal_ids.push(j.id);
        }
    }
    Ok(journal_ids)
}

fn count_live_entries_in_journals(
    conn: &Connection,
    journal_ids: &[String],
) -> Result<i64, String> {
    let mut total: i64 = 0;
    for jid in journal_ids {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE journal_id = ?1 AND is_deleted = 0",
                [jid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        total += count;
    }
    Ok(total)
}

/// How many full catalog batches already exist in the given journals.
pub fn peek_seed_generation(conn: &Connection) -> Result<u32, String> {
    let journal_ids = demo_journal_ids(conn)?;
    generation_for_journals(conn, &journal_ids)
}

/// True when demo journals already contain any live entries (seed was applied once).
pub fn is_seed_demo_applied(conn: &Connection) -> Result<bool, String> {
    let journal_ids = demo_journal_ids(conn)?;
    if journal_ids.is_empty() {
        return Ok(false);
    }
    Ok(count_live_entries_in_journals(conn, &journal_ids)? > 0)
}

fn generation_for_journals(conn: &Connection, journal_ids: &[String]) -> Result<u32, String> {
    if journal_ids.is_empty() {
        return Ok(0);
    }
    let total = count_live_entries_in_journals(conn, journal_ids)?;
    let per_run = demo_entries().len().max(1) as i64;
    Ok((total / per_run) as u32)
}

fn tag_exists_active(conn: &Connection, name: &str) -> Result<bool, String> {
    use rusqlite::OptionalExtension;
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM tags WHERE name = ?1 AND is_deleted = 0",
            [name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

/// Build a distinct title/body for this generation so re-runs are not clones
/// when using the static catalog (wiki re-fetches already unique pages).
fn vary_entry_for_generation(
    title: &str,
    paragraphs: &[&str],
    generation: u32,
    run_suffix: &str,
) -> (String, Vec<String>) {
    let mut owned: Vec<String> = paragraphs.iter().map(|p| (*p).to_string()).collect();

    let title = if generation == 0 {
        title.to_string()
    } else {
        format!("{title} · #{generation}")
    };

    if generation > 0 {
        // Lightly diversify the opening so content_text / previews differ.
        if let Some(first) = owned.first_mut() {
            first.push_str(&format!(" (batch #{generation})"));
        }
        owned.push(format!(
            "Demo batch #{generation} (run {run_suffix}). Re-seeded for local QA — intentionally different from earlier batches."
        ));
    }

    (title, owned)
}

/// Resolve title + paragraphs: Wikipedia when present, else catalog (+ gen vary).
fn resolve_entry_text(
    demo_title: &str,
    demo_paragraphs: &[&str],
    wiki: Option<&WikiEntryText>,
    generation: u32,
    run_suffix: &str,
) -> (String, Vec<String>) {
    if let Some(w) = wiki {
        // Fresh random article each seed — already unique across re-runs.
        let title = if generation == 0 {
            w.title.clone()
        } else {
            format!("{} · #{}", w.title, generation)
        };
        let mut paragraphs = w.paragraphs.clone();
        if generation > 0 {
            paragraphs.push(format!(
                "Demo batch #{generation} (run {run_suffix}; source: Wikipedia/{})",
                w.lang
            ));
        }
        (title, paragraphs)
    } else {
        vary_entry_for_generation(demo_title, demo_paragraphs, generation, run_suffix)
    }
}

/// Seed demo journals/entries/tags/media using production helpers.
///
/// **First run:** creates catalog tags + `[Demo]` journals + one batch of entries.
/// **Re-runs:** reuses those journals and tags; only inserts a new entry batch
/// Seeds demo journals/entries once. Uses catalog bodies unless
/// [`SeedOptions::wiki_texts`] overrides a slot. Photo fetch failures are
/// non-fatal (skipped + logged); other errors abort.
///
/// **One-shot:** if demo journals already have live entries, returns an error
/// so the UI can keep the Seed button disabled after the first successful run.
pub fn run_seed_demo(
    conn: &Connection,
    media_dir: &Path,
    opts: SeedOptions,
) -> Result<SeedDemoResult, String> {
    let now_unix = resolve_now_unix(&opts);
    let run_suffix = opts
        .run_suffix
        .clone()
        .unwrap_or_else(|| now_unix.to_string());

    // Refuse re-seed when curated demo data is already present.
    if is_seed_demo_applied(conn)? {
        return Err("Demo data already seeded. Delete the [Demo] journals to seed again.".into());
    }

    // ── 1. Tags (get-or-create; only count newly inserted) ─────────────────
    let mut tag_by_name: HashMap<String, String> = HashMap::new();
    let mut tags_created = 0u32;
    for tag in demo_tags() {
        let existed = tag_exists_active(conn, tag.name)?;
        let created = db::create_tag(conn, tag.name, Some(tag.color)).map_err(|e| e.to_string())?;
        if !existed {
            tags_created += 1;
        }
        tag_by_name.insert(created.name.clone(), created.id);
    }

    // ── 2. Journals (create demo journals; names are stable) ───────────────
    let existing_journals = db::list_journals(conn, None).map_err(|e| e.to_string())?;
    let mut journal_ids: Vec<String> = Vec::new();
    let mut journals_created = 0u32;
    for journal in demo_journals() {
        if let Some(found) = find_demo_journal(&existing_journals, journal.name) {
            journal_ids.push(found.id);
        } else {
            // Stable catalog name — no run suffix.
            let j = db::create_journal(conn, journal.name, Some(journal.color))
                .map_err(|e| e.to_string())?;
            journal_ids.push(j.id);
            journals_created += 1;
        }
    }

    // Always first (and only) batch when we reach here.
    let generation = 0u32;

    // ── 3. Entries (single curated batch) ──────────────────────────────────
    let mut entries_created = 0u32;
    let mut media_created = 0u32;

    for (entry_idx, demo) in demo_entries().iter().enumerate() {
        let journal_id = journal_ids.get(demo.journal_index).ok_or_else(|| {
            format!(
                "seed: entry {:?} has out-of-range journal_index {}",
                demo.title, demo.journal_index
            )
        })?;

        let wiki = opts
            .wiki_texts
            .as_ref()
            .and_then(|v| v.get(entry_idx))
            .and_then(|slot| slot.as_ref());
        let (title, paragraphs) =
            resolve_entry_text(demo.title, demo.paragraphs, wiki, generation, &run_suffix);

        // Shift each generation further into the past; add a small per-run
        // second offset so two clicks on the same calendar day still differ.
        let day_offset = demo.day_offset - (generation as i32) * GENERATION_DAY_SPAN;
        let second_skew = (generation as i64)
            .wrapping_mul(3_601)
            .wrapping_add((entry_idx as i64) % 59);
        let entry_date = now_unix + (day_offset as i64) * 86_400 + second_skew;

        let entry = create_entry_impl(conn, journal_id, Some(&title), None, None, entry_date)?;

        // Media first (inline photos, then attached audio/file).
        let mut inline_media_ids: Vec<String> = Vec::new();

        for photo_i in 0..demo.media.inline_photos {
            let picsum_seed = picsum_seed_for(entry_idx, photo_i, generation);
            let bytes = match fetch_image_bytes(&opts, picsum_seed) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("seed: skip photo for entry {}: {e}", demo.title);
                    continue;
                }
            };
            match save_media_to_media_dir(conn, media_dir, &entry.id, &bytes, "jpg", "inline") {
                Ok(result) => {
                    inline_media_ids.push(result.media_id);
                    media_created += 1;
                }
                Err(e) => {
                    eprintln!("seed: skip photo save for entry {}: {e}", demo.title);
                }
            }
        }

        if demo.media.attach_audio {
            let wav = synth_wav_tone(1500, 16_000);
            save_media_to_media_dir(conn, media_dir, &entry.id, &wav, "wav", "attached")?;
            media_created += 1;
        }

        if demo.media.attach_file {
            let (bytes, ext) = synth_text_file(&title);
            save_media_to_media_dir(conn, media_dir, &entry.id, &bytes, &ext, "attached")?;
            media_created += 1;
        }

        // Yjs body with inline image media ids.
        let media_refs: Vec<(&str, &str)> = inline_media_ids
            .iter()
            .map(|id| (id.as_str(), "image"))
            .collect();
        let para_refs: Vec<&str> = paragraphs.iter().map(|s| s.as_str()).collect();
        let (yjs, content_text, preview_text) = build_entry_yjs(&para_refs, &media_refs);
        save_entry_content_impl(conn, &entry.id, &yjs, &content_text, &preview_text)?;

        // Emotion is required on every catalog entry and must match the story arc.
        update_entry_emotion_impl(conn, &entry.id, Some(demo.emotion))?;

        for tag_name in demo.tag_names {
            if let Some(tag_id) = tag_by_name.get(*tag_name) {
                add_tag_to_entry_impl(conn, &entry.id, tag_id)?;
            } else {
                eprintln!("seed: tag {tag_name:?} not found for entry {}", demo.title);
            }
        }

        if demo.favorite {
            let _ = toggle_favorite_impl(conn, &entry.id)?;
        }

        if let Some(loc) = demo.location {
            update_entry_location_impl(
                conn,
                &entry.id,
                Some(loc.lat),
                Some(loc.lng),
                Some(loc.name),
                None,
            )?;
        }

        if let Some(weather) = demo.weather {
            update_entry_weather_impl(conn, &entry.id, Some(weather), None)?;
        }

        entries_created += 1;
    }

    Ok(SeedDemoResult {
        journals_created,
        entries_created,
        tags_created,
        media_created,
        journal_ids,
        run_suffix,
        generation,
    })
}

fn fetch_image_bytes(opts: &SeedOptions, picsum_seed: u32) -> Result<Vec<u8>, String> {
    if let Some(ref fetch) = opts.fetch_image {
        fetch(picsum_seed)
    } else {
        fetch_picsum_jpeg(picsum_seed, 800, 600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::migrate;
    use crate::seed::media_synth::minimal_jpeg_bytes;
    use rusqlite::Connection;

    fn seed_offline_at(
        now: i64,
        suffix: &str,
        conn: &Connection,
        media_dir: &Path,
    ) -> SeedDemoResult {
        let opts = SeedOptions {
            now_unix: Some(now),
            fetch_image: Some(Box::new(|_| Ok(minimal_jpeg_bytes()))),
            run_suffix: Some(suffix.into()),
            wiki_texts: None,
        };
        run_seed_demo(conn, media_dir, opts).unwrap()
    }

    fn seed_offline() -> (Connection, tempfile::TempDir, SeedDemoResult) {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let result = seed_offline_at(1_700_000_000, "test", &conn, dir.path());
        (conn, dir, result)
    }

    #[test]
    fn run_seed_demo_creates_expected_counts_and_content() {
        let (conn, dir, result) = seed_offline();

        assert_eq!(result.journals_created, 3);
        assert_eq!(result.journal_ids.len(), 3);
        assert_eq!(result.run_suffix, "test");
        assert_eq!(result.generation, 0);
        assert_eq!(
            result.entries_created, 40,
            "entries_created={}",
            result.entries_created
        );
        assert!(result.tags_created >= 1);
        assert!(
            result.media_created > 0,
            "catalog has media plans; media_created={}",
            result.media_created
        );

        // Every entry has non-empty yjs_doc + content_text.
        let entry_ids: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT id FROM entries WHERE is_deleted = 0")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(entry_ids.len() as u32, result.entries_created);

        for id in &entry_ids {
            let yjs = db::get_entry_content(&conn, id)
                .unwrap()
                .expect("yjs_doc present");
            assert!(!yjs.is_empty(), "empty yjs_doc for {id}");

            let entry = db::get_entry(&conn, id).unwrap().expect("entry row");
            let content = entry.content_text.unwrap_or_default();
            assert!(!content.is_empty(), "empty content_text for {id}");
        }

        // ≥1 tag link
        let tag_links: i64 = conn
            .query_row("SELECT COUNT(*) FROM entry_tags", [], |r| r.get(0))
            .unwrap();
        assert!(tag_links >= 1, "expected ≥1 entry_tags row");

        // Every seeded entry must carry a catalog emotion (good|neutral|bad).
        let emotion_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE emotion IN ('good','neutral','bad')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            emotion_count as u32, result.entries_created,
            "expected emotion on every seeded entry, got {emotion_count}/{}",
            result.entries_created
        );

        // Emotion must match the catalog for the same title (not random).
        for demo in demo_entries() {
            let emotion: String = conn
                .query_row(
                    "SELECT emotion FROM entries WHERE title = ?1",
                    [demo.title],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("missing seeded entry for title {}", demo.title));
            assert_eq!(
                emotion.as_str(),
                demo.emotion,
                "emotion mismatch for {}",
                demo.title
            );
        }

        // ≥1 favorite
        let fav_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE is_favorite != 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(fav_count >= 1, "expected ≥1 favorite");

        // Media files on disk for media rows
        let media_rows: Vec<(String, String)> = {
            let mut stmt = conn.prepare("SELECT id, storage_path FROM media").unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(!media_rows.is_empty());
        assert_eq!(media_rows.len() as u32, result.media_created);

        for (media_id, storage_path) in &media_rows {
            let path = Path::new(storage_path);
            assert!(
                path.exists(),
                "media file missing for {media_id}: {storage_path}"
            );
            // Files should live under the temp media dir.
            assert!(
                path.starts_with(dir.path()),
                "media path {storage_path} not under {:?}",
                dir.path()
            );
        }

        // Journal names are stable catalog names (no run suffix).
        for jid in &result.journal_ids {
            let j = db::get_journal(&conn, jid).unwrap().expect("journal");
            assert!(
                j.name.contains("[Demo]"),
                "journal name missing [Demo]: {}",
                j.name
            );
            assert!(
                !j.name.contains(" · "),
                "journal name should not include run suffix: {}",
                j.name
            );
        }
    }

    #[test]
    fn run_seed_demo_marks_entries_pending() {
        let (conn, _dir, result) = seed_offline();
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE sync_status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            pending as u32 >= result.entries_created,
            "expected pending sync_state for seeded entries, got {pending}"
        );
    }

    #[test]
    fn run_seed_demo_is_one_shot() {
        let (conn, dir, first) = seed_offline();
        assert_eq!(first.journals_created, 3);
        assert!(first.tags_created >= 1);
        assert_eq!(first.generation, 0);
        assert!(is_seed_demo_applied(&conn).unwrap());

        let err = run_seed_demo(
            &conn,
            dir.path(),
            SeedOptions {
                now_unix: Some(1_700_000_100),
                fetch_image: Some(Box::new(|_| {
                    Ok(crate::seed::media_synth::minimal_jpeg_bytes())
                })),
                run_suffix: Some("test2".into()),
                wiki_texts: None,
            },
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("already"),
            "expected already-seeded error, got: {err}"
        );

        let total_entries: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE is_deleted = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            total_entries as u32, first.entries_created,
            "second run must not insert more entries"
        );
    }

    #[test]
    fn is_seed_demo_applied_false_before_seed() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::migrate(&conn).unwrap();
        assert!(!is_seed_demo_applied(&conn).unwrap());
    }

    #[test]
    fn picsum_seed_includes_generation() {
        assert_eq!(picsum_seed_for(0, 0, 0), 1);
        assert_eq!(picsum_seed_for(1, 0, 0), 32);
        assert_eq!(picsum_seed_for(2, 1, 0), 64);
        assert_eq!(picsum_seed_for(0, 0, 1), 10_001);
        assert_ne!(
            picsum_seed_for(0, 0, 0),
            picsum_seed_for(0, 0, 1),
            "generation must change picsum seed"
        );
    }

    #[test]
    fn wiki_texts_override_catalog_title_and_body() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let dir = tempfile::tempdir().unwrap();

        let n = demo_entries().len();
        let mut wiki_slots: Vec<Option<WikiEntryText>> = (0..n)
            .map(|i| {
                Some(WikiEntryText {
                    title: format!("Wiki Title {i}"),
                    paragraphs: vec![format!("Wiki paragraph {i} with meaningful text.")],
                    lang: "en".into(),
                })
            })
            .collect();
        // Leave one slot empty → that entry must fall back to catalog.
        wiki_slots[0] = None;

        let opts = SeedOptions {
            now_unix: Some(1_700_000_000),
            fetch_image: Some(Box::new(|_| Ok(minimal_jpeg_bytes()))),
            run_suffix: Some("wiki-test".into()),
            wiki_texts: Some(wiki_slots),
        };
        let result = run_seed_demo(&conn, dir.path(), opts).unwrap();
        assert_eq!(result.entries_created as usize, n);

        let titles: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT COALESCE(title, '') FROM entries WHERE is_deleted = 0")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(
            titles.iter().any(|t| t.starts_with("Wiki Title ")),
            "expected wiki titles, got {titles:?}"
        );
        // Catalog first entry title when slot 0 is None
        assert!(
            titles
                .iter()
                .any(|t| t == "Bấm deploy và thấy mình lớn hơn"),
            "expected catalog fallback for slot 0, got {titles:?}"
        );

        let wiki_bodies: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries WHERE is_deleted = 0 AND content_text LIKE 'Wiki paragraph%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(wiki_bodies as usize, n - 1);
    }

    #[test]
    fn reuses_legacy_suffixed_journal_names() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let dir = tempfile::tempdir().unwrap();

        // Simulate pre-fix seed names: "[Demo] Personal · 123"
        for catalog in demo_journals() {
            let name = format!("{} · 123", catalog.name);
            db::create_journal(&conn, &name, Some(catalog.color)).unwrap();
        }

        let result = seed_offline_at(1_700_000_000, "test", &conn, dir.path());
        assert_eq!(result.journals_created, 0);
        assert_eq!(result.journal_ids.len(), 3);

        let demo_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM journals WHERE is_deleted = 0 AND name LIKE '[Demo]%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(demo_count, 3, "must not create parallel demo journals");
    }
}
