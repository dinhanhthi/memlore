use crate::db::seeds;
use rusqlite::{Connection, Result};

/// Run all schema migrations. Creates tables, FTS5 virtual table, triggers,
/// and inserts a default journal if none exists. Safe to call multiple times
/// (uses CREATE TABLE IF NOT EXISTS throughout).
pub fn migrate(conn: &Connection) -> Result<()> {
    // FTS5 schema-drift guard. Pre-Phase-2 dev DBs created `entries_fts` with
    // one indexed column (`content_text` only). Phase 2 adds `title` so both
    // fields participate in full-text search. Because
    // `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op when the table exists,
    // a dev who does not wipe their DB would retain the old one-column shape
    // with our new two-column triggers, producing weird half-broken behavior.
    // Detect that drift and recreate.
    //
    // This check is safe on a fresh DB (table does not exist → column count
    // is 0 → we fall through to the CREATE VIRTUAL TABLE below) and on an
    // already-correct DB (column count is 2 → we skip the recreate).
    let fts_was_rebuilt = drop_fts_if_drifted(conn)?;
    // The FTS `CREATE VIRTUAL TABLE` below indexes the `*_fold` generated
    // columns. An older dev DB whose `entries` table predates them would make
    // that CREATE fail, so backfill the columns on the existing table first.
    add_fold_columns_if_missing(conn)?;
    add_from_chat_column_if_missing(conn)?;
    drop_reminders_if_drifted(conn)?;

    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS journals (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            color       TEXT,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            is_locked   INTEGER DEFAULT 0,
            is_invisible INTEGER DEFAULT 0,
            -- Multi-vault invisible lock ownership (nullable). Non-null only
            -- when is_invisible=1 and bound to an invisible_vaults row.
            -- No FK: SQLite ALTER cannot add FKs later; setters enforce integrity.
            vault_id    TEXT,
            is_initial_placeholder INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS entries (
            id               TEXT PRIMARY KEY NOT NULL,
            journal_id       TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
            title            TEXT,
            preview_text     TEXT,
            content_text     TEXT,
            entry_date       INTEGER NOT NULL,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL,
            latitude         REAL,
            longitude        REAL,
            location_label   TEXT,
            location_address TEXT,
            weather_summary  TEXT,
            weather_icon     TEXT,
            -- 3-state emotion: stored as a short string ('good' | 'neutral' | 'bad')
            -- or NULL when the user hasn't tagged. Replaces the prior 8-emoji +
            -- 1-5 intensity scheme (see migration `emotions_v2_3_state_migrated`
            -- below). Validated at the writer layer in `db::queries::update_entry_emotion`.
            emotion          TEXT,
            is_favorite      INTEGER DEFAULT 0,
            is_deleted       INTEGER DEFAULT 0,
            is_locked        INTEGER DEFAULT 0,
            is_invisible     INTEGER DEFAULT 0,
            -- Multi-vault invisible lock ownership (nullable). Non-null only
            -- when is_invisible=1 and bound to an invisible_vaults row.
            -- No FK: SQLite ALTER cannot add FKs later; setters enforce integrity.
            vault_id         TEXT,
            yjs_doc          BLOB,
            -- ID of the media row whose thumbnail is shown as the entry cover
            -- in lists. Plain TEXT (no FK) because SQLite ALTER TABLE cannot
            -- add FKs after the table exists, and we keep the on-create
            -- definition consistent with the ALTER fallback below for older
            -- dev DBs. The `clear_entry_cover_on_media_delete` trigger
            -- emulates ON DELETE SET NULL.
            cover_media_id   TEXT,
            -- Durable flag set to 1 once the user finalises the date for
            -- this entry (manual edit, EXIF-suggestion confirm, or modal
            -- dismiss). Fresh entries default to 0 so EXIF suggestions
            -- still fire on first insert; the frontend reads this column
            -- to suppress the modal across navigation.
            entry_date_user_edited INTEGER DEFAULT 0,
            -- Denormalized count of `media` rows for this entry. Maintained
            -- by `bump_entry_media_count_on_insert` /
            -- `bump_entry_media_count_on_delete` triggers so entry-list
            -- cards can show a badge without N+1 COUNT queries.
            media_count      INTEGER NOT NULL DEFAULT 0,
            -- Durable flag: 1 once this entry was created by converting a
            -- daily chat session. Flipped by `set_chat_session_conversion`
            -- (the single writer) so the entry-list card can show a
            -- chat-origin indicator without a per-card back-ref lookup.
            -- Local-only UX flag; not synced.
            from_chat        INTEGER NOT NULL DEFAULT 0,
            -- Accent-folded mirrors of `title` / `content_text` used *only* as
            -- the FTS5 index source. The `unicode61 remove_diacritics 2`
            -- tokenizer folds every Vietnamese tone/vowel diacritic at tokenize
            -- time (ử→u, ạ→a, …) but leaves `đ`/`Đ` untouched, so we fold that
            -- one letter here. VIRTUAL (computed on read) so it costs no extra
            -- storage and can be added to older dev DBs via ALTER TABLE (STORED
            -- cannot). External-content FTS reads these columns directly on
            -- `'rebuild'`, so the fold must live in the column, not the trigger.
            title_fold   TEXT GENERATED ALWAYS AS
                (replace(replace(title, 'đ', 'd'), 'Đ', 'D')) VIRTUAL,
            content_fold TEXT GENERATED ALWAYS AS
                (replace(replace(content_text, 'đ', 'd'), 'Đ', 'D')) VIRTUAL
        );

        CREATE TABLE IF NOT EXISTS tags (
            id         TEXT PRIMARY KEY NOT NULL,
            name       TEXT NOT NULL UNIQUE,
            color      TEXT,
            -- Per-row LWW key for the tags sync channel. Bumped by every
            -- create / update / soft-delete. Old rows from pre-sync dev
            -- DBs default to 0; any peer write strictly outranks them.
            updated_at INTEGER NOT NULL DEFAULT 0,
            -- Soft-delete tombstone so deletions can propagate across
            -- devices. Queries filter `is_deleted = 0` for the user-
            -- facing tag list; the sync channel includes tombstones so
            -- peers can clean up locally.
            is_deleted INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS entry_tags (
            entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (entry_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS media (
            id               TEXT PRIMARY KEY NOT NULL,
            entry_id         TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            file_name        TEXT NOT NULL,
            file_type        TEXT NOT NULL,
            storage_provider TEXT NOT NULL,
            storage_path     TEXT NOT NULL,
            thumbnail_path   TEXT,
            width            INTEGER,
            height           INTEGER,
            duration_seconds REAL,
            exif_date        INTEGER,
            exif_latitude    REAL,
            exif_longitude   REAL,
            sort_order       INTEGER DEFAULT 0,
            created_at       INTEGER NOT NULL,
            insertion_mode   TEXT NOT NULL DEFAULT 'inline'
                CHECK (insertion_mode IN ('inline', 'attached'))
        );

        -- POINT OF NO RETURN (T38): explicit media deletion tombstones.
        -- Once a peer honours a row, its media row / cached file / (own-cloud
        -- blob via reconcile_own_media_files) are gone. Honour only when
        -- local media.created_at <= deleted_at so a concurrent offline add
        -- is not wiped by an older LWW entry write.
        -- TODO(later): prune media_tombstones on entry hard-delete — see docs/LATER.md
        CREATE TABLE IF NOT EXISTS media_tombstones (
            id         TEXT PRIMARY KEY NOT NULL,
            entry_id   TEXT NOT NULL,
            deleted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_media_tombstones_entry
            ON media_tombstones(entry_id);

        CREATE TABLE IF NOT EXISTS location_aliases (
            id            TEXT PRIMARY KEY NOT NULL,
            address       TEXT NOT NULL,
            latitude      REAL NOT NULL,
            longitude     REAL NOT NULL,
            label         TEXT NOT NULL,
            radius_meters REAL DEFAULT 100,
            created_at    INTEGER NOT NULL DEFAULT 0,
            updated_at    INTEGER NOT NULL DEFAULT 0,
            is_deleted    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS templates (
            id            TEXT PRIMARY KEY NOT NULL,
            name          TEXT NOT NULL,
            description   TEXT,
            content       BLOB,
            is_predefined INTEGER DEFAULT 0,
            sort_order    INTEGER DEFAULT 0,
            created_at    INTEGER NOT NULL,
            -- LWW key for the user-template sync channel. Predefined
            -- templates are seeded locally on each device and do not
            -- ride on the wire.
            updated_at    INTEGER NOT NULL DEFAULT 0,
            is_deleted    INTEGER NOT NULL DEFAULT 0
        );

        -- Phase 6 v2 R9 v2: Daily Chat persistent sessions. Each chat
        -- conversation lives as one `chat_sessions` row + N
        -- `chat_messages` rows (ordered by `seq`, ascending). Persona
        -- + language are snapshotted at session creation so older
        -- sessions retain their original persona even if the global
        -- setting changes later.
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id                       TEXT PRIMARY KEY NOT NULL,
            title                    TEXT,
            persona                  TEXT NOT NULL DEFAULT 'empathetic',
            persona_prompt_snapshot  TEXT NOT NULL,
            language                 TEXT NOT NULL DEFAULT 'auto',
            created_at               INTEGER NOT NULL,
            updated_at               INTEGER NOT NULL,
            -- Soft-delete tombstone for cross-device sync of session
            -- deletions. Sessions stay in the DB so the tombstone can
            -- propagate; user-facing lists filter `is_deleted = 0`.
            is_deleted               INTEGER NOT NULL DEFAULT 0,
            -- Sticky flag: set the first time a turn injects journal
            -- context (auto-RAG or attachment), never cleared. Drives
            -- a 'this conversation used your entries' icon in the
            -- session list.
            used_rag                 INTEGER NOT NULL DEFAULT 0,
            -- Daily Chat → Entry conversion watermark. Both nullable.
            -- `converted_entry_id` has NO FK (dangling ids handled at
            -- read time — do NOT add REFERENCES/ON DELETE, it would
            -- reorder sync writes). The partial index
            -- `idx_chat_sessions_converted_entry` backs the entry
            -- back-reference banner lookup.
            converted_entry_id       TEXT,
            converted_through_seq    INTEGER,
            -- Epoch SECONDS when the user pinned this session (same clock as
            -- `created_at`/`updated_at` — `now_unix()` is `.as_secs()`), NULL
            -- when unpinned. Drives the pin-to-top sort in the session list.
            pinned_at                INTEGER
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id          TEXT PRIMARY KEY NOT NULL,
            session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content     TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            -- Per-message AI call metadata (assistant rows only; user rows stay NULL)
            model_id        TEXT,
            provider_id     TEXT,
            endpoint_class  TEXT,
            tokens_in       INTEGER,
            tokens_out      INTEGER,
            latency_ms      INTEGER,
            -- User rows only: what the user explicitly attached before
            -- sending, as a JSON array of entry/period refs (NULL when
            -- nothing was attached).
            attachments        TEXT,
            -- Assistant rows only: the resolved entry IDs actually used
            -- to build this reply's context, as a JSON array (NULL when
            -- no context was injected).
            source_entry_ids   TEXT,
            -- Assistant rows only: the memory_items ids folded into this
            -- reply's prompt, as a JSON array (NULL when none were used).
            -- memory_items themselves DO sync (via memory.bin, plan decision
            -- 10), so these ids are carried in chats.bin too (see
            -- list_syncable_chat_sessions / upsert_synced_chat_message) —
            -- same posture as source_entry_ids. Text is resolved live from
            -- memory_items at render time, not persisted here.
            memory_ids         TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq
            ON chat_messages(session_id, seq);

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
            ON chat_sessions(updated_at DESC);

        -- Partial index backing the entry back-reference banner lookup.
        -- Duplicated here (next to `idx_chat_sessions_updated`) AND in the
        -- ALTER migration block below so the schema reads consistently
        -- regardless of which path a DB took. `CREATE INDEX IF NOT EXISTS`
        -- keeps both idempotent.
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_converted_entry
            ON chat_sessions(converted_entry_id) WHERE converted_entry_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS streak_cache (
            user_id         TEXT PRIMARY KEY DEFAULT 'local',
            current_streak  INTEGER DEFAULT 0,
            longest_streak  INTEGER DEFAULT 0,
            last_entry_date INTEGER,
            -- Bumped every time `recalculate_streak` writes. Drives LWW
            -- for the streak sync channel. Devices compute streaks
            -- independently; the most-recently-computed wins.
            updated_at      INTEGER NOT NULL DEFAULT 0
        );

        -- The legacy `prompts` table (writing-prompts feature) was removed in
        -- 2026-05. The DROP is harmless on fresh DBs and cleans up dev DBs
        -- that still carry the old table.
        DROP TABLE IF EXISTS prompts;

        -- Invisible Lock multi-vault: each deniable password is one vault row
        -- (Argon2 PHC verifier). Ownership lives on entries/journals.vault_id.
        -- Hard cut from the single settings.invisible_lock_verifier key —
        -- no migrate-from-verifier path (dev wipe OK).
        CREATE TABLE IF NOT EXISTS invisible_vaults (
            id         TEXT PRIMARY KEY NOT NULL,
            verifier   TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY NOT NULL,
            value      TEXT NOT NULL,
            -- Bumped by `set_setting` on every write. Drives per-key LWW
            -- during the sync engine's settings.bin merge. Default of 0
            -- is what older rows pick up on the ALTER fallback below; any
            -- fresh peer write strictly outranks them.
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        -- Reminders use a 7-bit weekday bitmask:
        --   bit 0 = Monday, bit 1 = Tue, … bit 6 = Sun.
        --   All days  → 127 (0b1111111).
        --   Mon–Fri   → 31  (0b0011111).
        --   At least one bit must be set (CHECK 1..=127).
        -- This replaces the older `frequency` enum + single `weekday` column.
        CREATE TABLE IF NOT EXISTS reminders (
            id              TEXT PRIMARY KEY NOT NULL,
            label           TEXT NOT NULL,
            time_of_day     TEXT NOT NULL,
            weekdays        INTEGER NOT NULL
                CHECK(weekdays BETWEEN 1 AND 127),
            enabled         INTEGER NOT NULL DEFAULT 1,
            last_fired_at   INTEGER,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );

        -- Chunk 3a: sync state is kept in its own table (not columns on
        -- `entries`) so it can be wiped/rebuilt without touching user data
        -- and so pending counts are a cheap index scan, not a full scan.
        --
        -- Chunk 3c adds three `settings` rows — `sync_provider`,
        -- `sync_config_json`, `last_sync_at` — for provider metadata
        -- (see `db::queries`). Those are plain key/value rows and need no
        -- schema change because the `settings` table is already generic.
        CREATE TABLE IF NOT EXISTS sync_state (
            entry_id        TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
            local_version   INTEGER NOT NULL DEFAULT 1,
            synced_version  INTEGER NOT NULL DEFAULT 0,
            last_synced_at  INTEGER,
            sync_status     TEXT NOT NULL DEFAULT 'pending'
                CHECK(sync_status IN ('pending', 'synced', 'conflict'))
        );
        CREATE INDEX IF NOT EXISTS idx_sync_state_status ON sync_state(sync_status);

        -- Version History (2026-07-05): per-entry editing-session snapshots.
        -- `yjs_doc` is a full Y.encodeStateAsUpdate blob (not a diff), so
        -- restore/preview can decode any single row independent of the
        -- others. Rows are immutable/append-only once written — never
        -- mutated — so cross-device sync is a plain union, no CRDT
        -- reconciliation needed. Pruned by `prune_entry_versions`
        -- (retention_days, default 7, user-configurable 3/7/15) and a
        -- hidden 50-versions-per-entry cap. `upload_status`/`cloud_path`
        -- mirror the `media` table's own-device-folder sync columns
        -- (Phase 2 wires the actual upload).
        CREATE TABLE IF NOT EXISTS entry_versions (
            id            TEXT PRIMARY KEY NOT NULL,
            entry_id      TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            yjs_doc       BLOB NOT NULL,
            preview_text  TEXT NOT NULL DEFAULT '',
            created_at    INTEGER NOT NULL,
            device_id     TEXT NOT NULL,
            upload_status TEXT NOT NULL DEFAULT 'pending'
                CHECK(upload_status IN ('pending','uploaded')),
            cloud_path    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_entry_versions_entry
            ON entry_versions(entry_id, created_at DESC);

        -- FTS5 indexes the accent-folded mirrors of title and content_text so
        -- search is diacritic-insensitive (Vietnamese thu-thach matches
        -- thu-thach-with-accents). remove_diacritics 2 folds tone/vowel marks;
        -- the *_fold generated columns fold d-with-stroke. All columns are
        -- plaintext at the application layer; SQLCipher provides at-rest
        -- encryption transparently via per-page AES-CBC + per-page HMAC-SHA512.
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
            USING fts5(
                title_fold,
                content_fold,
                content='entries',
                content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            );

        CREATE TRIGGER IF NOT EXISTS entries_ai
            AFTER INSERT ON entries
        BEGIN
            INSERT INTO entries_fts(rowid, title_fold, content_fold)
            VALUES (new.rowid, new.title_fold, new.content_fold);
        END;

        CREATE TRIGGER IF NOT EXISTS entries_au
            AFTER UPDATE ON entries
        BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title_fold, content_fold)
            VALUES ('delete', old.rowid, old.title_fold, old.content_fold);
            INSERT INTO entries_fts(rowid, title_fold, content_fold)
            VALUES (new.rowid, new.title_fold, new.content_fold);
        END;

        CREATE TRIGGER IF NOT EXISTS entries_ad
            AFTER DELETE ON entries
        BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, title_fold, content_fold)
            VALUES ('delete', old.rowid, old.title_fold, old.content_fold);
        END;

        -- Cover image: emulate `cover_media_id ON DELETE SET NULL`. SQLite
        -- ALTER TABLE cannot add a real FK after the column exists, so for
        -- DBs that received `cover_media_id` via the migration fallback below
        -- we rely on this trigger. Per-row semantics — a multi-row DELETE
        -- on `media` (or a CASCADE delete of an entry) fires the trigger
        -- once per row and clears the cover where it matches.
        CREATE TRIGGER IF NOT EXISTS clear_entry_cover_on_media_delete
            AFTER DELETE ON media
        BEGIN
            UPDATE entries SET cover_media_id = NULL
            WHERE cover_media_id = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS bump_entry_media_count_on_insert
            AFTER INSERT ON media
        BEGIN
            UPDATE entries SET media_count = media_count + 1
            WHERE id = NEW.entry_id;
        END;

        CREATE TRIGGER IF NOT EXISTS bump_entry_media_count_on_delete
            AFTER DELETE ON media
        BEGIN
            UPDATE entries SET media_count = media_count - 1
            WHERE id = OLD.entry_id;
        END;

        -- Embedding Cost Guardrails Phase 1 (2026-07-12): the old entry-level
        -- `entries_embeddings` table (one vector per whole entry) is replaced
        -- by chunk-level vectors + a device-local dirty queue. See the DROP
        -- below (dev-mode wipe, no migration shim — CLAUDE.md) and the two
        -- tables that replace it.
        --
        -- `entry_embedding_chunks`: one row per (entry, model, chunk). A
        -- long entry is split into several semantically-bounded chunks
        -- (paragraph/heading/list boundaries — see `ai::chunking`, Task 2)
        -- so retrieval can return the specific passage that matched instead
        -- of the whole entry. `content_hash` is a hash of the *normalized*
        -- chunk text, `char_start`/`char_end` are offsets into the entry's
        -- canonical indexable text, `preview` is a short excerpt for
        -- surfacing search hits without re-fetching entry content. `vec` is
        -- little-endian f32 bytes, length = `dim` * 4 (same convention as
        -- the table it replaces). `model_id` + `content_hash` are carried
        -- here (not just for dedupe) because this table is designed to
        -- become sync-eligible in Phase 5 — do not assume chunks stay
        -- device-local only.
        CREATE TABLE IF NOT EXISTS entry_embedding_chunks (
            entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            model_id     TEXT NOT NULL,
            chunk_index  INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            char_start   INTEGER NOT NULL,
            char_end     INTEGER NOT NULL,
            preview      TEXT,
            dim          INTEGER NOT NULL,
            vec          BLOB NOT NULL,
            indexed_at   INTEGER NOT NULL,
            PRIMARY KEY (entry_id, model_id, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_entry_embedding_chunks_model
            ON entry_embedding_chunks(model_id);
        CREATE INDEX IF NOT EXISTS idx_entry_embedding_chunks_entry_model
            ON entry_embedding_chunks(entry_id, model_id);

        -- `entry_embedding_jobs`: entry-level dirty queue. One row per
        -- (entry, model) tracks whether that entry's chunks need
        -- (re-)computing, so the save path only marks dirty (Task 4) and a
        -- background worker (Phase 2) claims due rows and does the actual
        -- provider calls. This table stays device-local and MUST NOT enter
        -- the Yjs sync payload — it is local scheduling state, not user
        -- content, and every device recomputes its own dirty set from its
        -- own `entries`/`entry_embedding_chunks` state.
        CREATE TABLE IF NOT EXISTS entry_embedding_jobs (
            entry_id        TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            model_id        TEXT NOT NULL,
            content_hash    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','in_progress','indexed','skipped','error','paused')),
            dirty_at        INTEGER NOT NULL,
            next_attempt_at INTEGER,
            last_attempt_at INTEGER,
            attempt_count   INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            updated_at      INTEGER NOT NULL,
            PRIMARY KEY (entry_id, model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_entry_embedding_jobs_model_status_due
            ON entry_embedding_jobs(model_id, status, next_attempt_at);

        -- ── AI User Memory (2026-07-29) ───────────────────────────────────────
        -- Four tables backing the on-machine user-memory feature
        -- (plan: docs/plans/2026-07-29-ai-user-memory/). Memory is extracted
        -- from two source kinds — Daily Chat sessions and journal entries — by
        -- an on-machine model, embedded on-device, and injected into Daily
        -- Chat. All four stay device-local except via the dedicated
        -- `{device}/memory.bin` sync surface (Phase 6). See the plan's
        -- Confirmed decisions section for the privacy boundary.

        -- `memory_items`: one row per distilled user fact. `source_type`
        -- records the source kind of the ORIGINAL extraction
        -- ('journal_entry' | 'daily_chat'); a single consolidated fact can
        -- later be backed by sources of either kind (tracked in
        -- `memory_item_sources`), but the row's own `source_type` never
        -- changes after the first extraction. `enabled = 0` hides the item
        -- from retrieval without deleting it; `is_deleted` is the soft-
        -- delete tombstone that propagates via sync. No FK on the PK
        -- because memory ids are uuids minted by the extractor and
        -- referenced from `memory_item_sources` / `memory_embeddings`.
        CREATE TABLE IF NOT EXISTS memory_items (
            id          TEXT PRIMARY KEY,
            text        TEXT NOT NULL,
            source_type TEXT NOT NULL
                CHECK(source_type IN ('journal_entry','daily_chat')),
            enabled     INTEGER NOT NULL DEFAULT 1,
            is_deleted  INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        -- `memory_item_sources`: the contributing sources behind each
        -- memory item. A consolidated fact can blend several journal
        -- entries or chat turns, so the join is many-to-many. The
        -- retrieval-time privacy re-check joins this → entries → journals
        -- to drop any memory backed by a currently locked/invisible entry
        -- (decision 8). `memory_id` is intentionally plain TEXT (no FK):
        -- memory_items rows ship in the same sync payload, but SQLite
        -- ALTER TABLE cannot add FKs later and the join is validated at
        -- read time, matching the `chat_sessions.converted_entry_id`
        -- posture. `source_id` is an entries.id or chat_sessions.id.
        CREATE TABLE IF NOT EXISTS memory_item_sources (
            memory_id   TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id   TEXT NOT NULL,
            PRIMARY KEY (memory_id, source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_item_sources_source
            ON memory_item_sources(source_type, source_id);

        -- `memory_embeddings`: one vector per (memory item, model). The
        -- memory embed slot is user-configurable, so an item can carry
        -- rows for several models over time (a model swap does not wipe
        -- the old vectors — they just stop matching the active model_id,
        -- and the worker backfill pass re-embeds under the new id).
        -- `vec` is little-endian f32 bytes, length = `dim` * 4 (same
        -- convention as `entry_embedding_chunks`). `content_hash` is a
        -- hash of the item text at embed time so a text edit can be
        -- detected without re-reading the row.
        CREATE TABLE IF NOT EXISTS memory_embeddings (
            memory_id    TEXT NOT NULL,
            model_id     TEXT NOT NULL,
            dim          INTEGER NOT NULL,
            vec          BLOB NOT NULL,
            content_hash TEXT NOT NULL,
            indexed_at   INTEGER NOT NULL,
            PRIMARY KEY (memory_id, model_id)
        );

        -- `memory_jobs`: scan-driven extraction watermark queue. Mirrors
        -- `entry_embedding_jobs` column shape, but extraction is
        -- scan-claimed rather than save-triggered: a scan finds sources
        -- whose live content_hash changed vs. the row and claims them.
        -- Keyed by (source_type, source_id) so both journal entries and
        -- chat sessions queue through the same table. `content_hash`
        -- records the content last processed; status/backoff/pause is
        -- required because a local Ollama endpoint can go down, time
        -- out, or return junk. Stays device-local — every device
        -- recomputes its own scan set.
        CREATE TABLE IF NOT EXISTS memory_jobs (
            source_type     TEXT NOT NULL,
            source_id       TEXT NOT NULL,
            content_hash    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','in_progress','indexed','skipped','error','paused')),
            attempt_count   INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER,
            last_attempt_at INTEGER,
            last_error      TEXT,
            updated_at      INTEGER NOT NULL,
            PRIMARY KEY (source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
            ON memory_jobs(status, next_attempt_at);

        -- Build Your Persona is one durable document, not a collection. The
        -- `id = 1` CHECK makes that singleton invariant structural, so a
        -- future writer cannot accidentally create a second profile row.
        CREATE TABLE IF NOT EXISTS user_persona (
            id           INTEGER PRIMARY KEY CHECK(id = 1),
            answers_json TEXT NOT NULL DEFAULT '',
            traits_text  TEXT NOT NULL DEFAULT '',
            style_text   TEXT NOT NULL DEFAULT '',
            enabled      INTEGER NOT NULL DEFAULT 1,
            user_edited  INTEGER NOT NULL DEFAULT 0,
            generated_at INTEGER,
            updated_at   INTEGER NOT NULL
        );

        -- Phase 6 Stretch S2-1: AI audit log. One row per AI provider call
        -- (chat / chat_stream / embed / generate_image). No content fields —
        -- only metadata about the call: timing, tokens (if reported), outcome.
        -- Retention: rows older than `ai_audit_retention_days` (default 90d)
        -- are purged once on startup by `ai::audit::run_startup_retention_purge`.
        --
        -- Sync: rows are scoped by `device_id` and identified by per-device
        -- `local_seq`. On pull, peer rows replace prior copies (snapshot-
        -- replace) so a peer's retention purge propagates everywhere. Push
        -- filters `device_id = self` to prevent replication loops.
        CREATE TABLE IF NOT EXISTS ai_audit_log (
            device_id       TEXT    NOT NULL,
            local_seq       INTEGER NOT NULL,
            created_at      INTEGER NOT NULL,
            feature         TEXT    NOT NULL,
            operation       TEXT    NOT NULL,
            provider_id     TEXT    NOT NULL,
            model_id        TEXT    NOT NULL,
            endpoint_host   TEXT    NOT NULL,
            endpoint_class  TEXT    NOT NULL,
            payload_bytes   INTEGER NOT NULL,
            latency_ms      INTEGER NOT NULL,
            status          TEXT    NOT NULL,
            error_code      TEXT,
            tokens_in       INTEGER,
            tokens_out      INTEGER,
            -- Snapshot of devices.name at the time the request was made.
            -- Empty for historical rows / peers that pre-date this field.
            device_name     TEXT    NOT NULL DEFAULT '',
            PRIMARY KEY (device_id, local_seq)
        );
        CREATE INDEX IF NOT EXISTS ai_audit_log_created_at_idx ON ai_audit_log(created_at);
        CREATE INDEX IF NOT EXISTS ai_audit_log_provider_idx   ON ai_audit_log(provider_id);
        CREATE INDEX IF NOT EXISTS ai_audit_log_feature_idx    ON ai_audit_log(feature);

        -- Cached AI period reviews / insights. Keyed by (kind, period_start,
        -- period_end) — one review per period. `model_id` is retained as a
        -- non-key column so the generating model is still recorded.
        CREATE TABLE IF NOT EXISTS ai_reviews (
            kind            TEXT    NOT NULL,
            period_start    INTEGER NOT NULL,
            period_end      INTEGER NOT NULL,
            model_id        TEXT    NOT NULL,
            result_json     TEXT    NOT NULL,
            entry_count     INTEGER NOT NULL,
            created_at      INTEGER NOT NULL,
            PRIMARY KEY (kind, period_start, period_end)
        );
        CREATE INDEX IF NOT EXISTS ai_reviews_created_at_idx ON ai_reviews(created_at);

        -- `ai_audit_log_device_idx` is created by the v2 migration block
        -- below (gated on `ai_audit_log_v2_composite_pk`). Creating it
        -- here would crash unlock on any pre-v2 DB whose `ai_audit_log`
        -- table still has the V1 shape (no `device_id` column): the
        -- `CREATE TABLE IF NOT EXISTS` above is a no-op against the V1
        -- table, and the index `ON ai_audit_log(device_id)` then fails
        -- with `no such column: device_id`, rolling back the whole
        -- batch before the v2 drop-and-rebuild migration can run.

        -- Google Fonts catalog cache (refresh-on-demand).
        -- `variants_json` is a JSON array of variant strings (e.g. ['regular','700']).
        -- `files_json` is a JSON object mapping variant key to TTF URL.
        CREATE TABLE IF NOT EXISTS google_fonts_catalog (
            family        TEXT PRIMARY KEY NOT NULL,
            category      TEXT NOT NULL,
            variants_json TEXT NOT NULL,
            files_json    TEXT NOT NULL
        );

        -- Single-row metadata for the catalog cache.
        -- CHECK (id=1) enforces the single-row invariant.
        CREATE TABLE IF NOT EXISTS google_fonts_catalog_meta (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            fetched_at  INTEGER NOT NULL,
            count       INTEGER NOT NULL
        );
        ",
    )?;

    // If `drop_fts_if_drifted` tore the FTS table down (old shape or old
    // tokenizer), the external-content index just recreated above is empty.
    // Repopulate it from the existing rows so search works immediately instead
    // of only indexing entries written after this migration.
    if fts_was_rebuilt {
        conn.execute(
            "INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')",
            [],
        )?;
    }

    // ── Incremental migrations ────────────────────────────────────────────────
    // Phase 2: add is_deleted column to journals for soft-delete support.
    // ALTER TABLE ... ADD COLUMN is idempotent-safe: we ignore the "duplicate column" error.
    let _ = conn.execute_batch("ALTER TABLE journals ADD COLUMN is_deleted INTEGER DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE journals ADD COLUMN is_locked INTEGER DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN is_locked INTEGER DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE journals ADD COLUMN is_invisible INTEGER DEFAULT 0;");
    let _ = conn.execute_batch(
        "ALTER TABLE journals ADD COLUMN is_initial_placeholder INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN is_invisible INTEGER DEFAULT 0;");
    // Multi-vault invisible lock: additive vault_id columns for older dev DBs.
    // Fresh CREATE TABLE already includes vault_id; duplicate-column is ignored.
    let _ = conn.execute_batch("ALTER TABLE journals ADD COLUMN vault_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN vault_id TEXT;");

    // Auto-apply tags: every new entry created in this journal gets these
    // tags attached automatically. Many-to-many junction so a journal can
    // have any number of auto-tags (zero = feature off).
    //
    // ON DELETE CASCADE on both sides keeps the table tidy without any
    // app-level cleanup: deleting a journal or a tag wipes the matching
    // rows automatically. (This is a fresh table created via CREATE TABLE,
    // so the FK constraints actually take effect — unlike post-hoc ALTER
    // TABLE columns which SQLite can't constrain.)
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS journal_auto_tags (
            journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
            tag_id     TEXT NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
            PRIMARY KEY (journal_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_journal_auto_tags_journal
            ON journal_auto_tags(journal_id);",
    )?;

    // Older dev DBs that received the singular `auto_tag_id` column from
    // the first iteration of this feature are migrated here: copy the
    // column into the new junction table, then drop the column.
    // SQLite can DROP COLUMN since 3.35.0 (2021-03). Wrapped in `let _ =`
    // so DBs that never had the column (fresh or post-this-migration)
    // ignore the "no such column" error gracefully.
    let _ = conn.execute_batch(
        "INSERT OR IGNORE INTO journal_auto_tags (journal_id, tag_id)
         SELECT id, auto_tag_id FROM journals WHERE auto_tag_id IS NOT NULL;",
    );
    let _ = conn.execute_batch("ALTER TABLE journals DROP COLUMN auto_tag_id;");

    // Phase 3 Chunk 6a: add sync-tracking columns to media table.
    let _ = conn.execute_batch(
        "ALTER TABLE media ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'pending' \
         CHECK(upload_status IN ('pending','uploaded','error'));",
    );
    let _ = conn.execute_batch("ALTER TABLE media ADD COLUMN uploaded_at INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE media ADD COLUMN file_size INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE media ADD COLUMN cloud_path TEXT;");
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_media_upload_status ON media(upload_status);",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE media ADD COLUMN awaiting_compression INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_media_awaiting_compression ON media(awaiting_compression);",
    );
    let _ =
        conn.execute_batch("ALTER TABLE media ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0;");

    // Phase 3 Chunk 6b: LRU cache tracking.
    // `last_accessed_at` is bumped by `resolve_media` on every cache hit so
    // the cache module can evict oldest-accessed cloud-downloaded files first.
    // Filesystem atime is unreliable (noatime mounts, re-copy on decrypt), so
    // we track access in the DB.
    let _ = conn.execute_batch("ALTER TABLE media ADD COLUMN last_accessed_at INTEGER;");
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_media_last_accessed_at ON media(last_accessed_at);",
    );

    // Phase 1 image insertion modes: ALTER fallback for dev DBs that already
    // have the `media` table but lack the `insertion_mode` column.
    // New DBs already have the column in the CREATE TABLE above.
    // SQLite supports CHECK constraints in ADD COLUMN since 3.37.0 (2021-11-27);
    // we wrap in let _ so a "duplicate column" error on already-migrated DBs is
    // silently ignored.
    let _ = conn.execute_batch(
        "ALTER TABLE media ADD COLUMN insertion_mode TEXT NOT NULL DEFAULT 'inline' \
         CHECK (insertion_mode IN ('inline', 'attached'));",
    );

    // Intrinsic pixel dimensions: ALTER fallback for dev DBs that have the
    // `media` table but lack the `width` / `height` columns. New DBs already
    // include them in the CREATE TABLE above. Same `let _` idempotency pattern
    // as `insertion_mode` — a "duplicate column" error on re-run is harmless.
    let _ = conn.execute_batch("ALTER TABLE media ADD COLUMN width INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE media ADD COLUMN height INTEGER;");

    // Phase 1 cover image: ALTER fallback for dev DBs created before this
    // column existed. New DBs already include `cover_media_id` via the inline
    // CREATE TABLE above, and the trigger that emulates ON DELETE SET NULL
    // is created in the main `execute_batch` so its errors propagate.
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN cover_media_id TEXT;");

    // Phase 6 A5: per-entry language tag. NULL means "never auto-detected
    // and never user-set". Auto-detection (`utils::language_detect`)
    // populates this on first save of an entry whose content is long
    // enough to be confidently classified; the editor's language pill
    // can override it manually. Once non-NULL, the auto-detect path
    // does NOT overwrite — first-detect-wins, with manual override
    // always trumping.
    //
    // The ALTER is wrapped in `let _ =` to swallow the duplicate-column
    // error on already-migrated DBs (matches the `cover_media_id`
    // pattern above). The CREATE INDEX, however, is `IF NOT EXISTS` —
    // it is itself idempotent, so any error reaching us here would
    // be a *real* problem (disk full, schema corruption); propagate
    // instead of silently masking.
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN content_language TEXT;");
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_entries_content_language \
         ON entries(content_language);",
    )?;

    // Entry-list media badge: denormalized count maintained by triggers.
    let _ = conn
        .execute_batch("ALTER TABLE entries ADD COLUMN media_count INTEGER NOT NULL DEFAULT 0;");
    conn.execute_batch(
        "UPDATE entries SET media_count = (
             SELECT COUNT(*) FROM media WHERE media.entry_id = entries.id
         );",
    )?;
    conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS bump_entry_media_count_on_insert
             AFTER INSERT ON media
         BEGIN
             UPDATE entries SET media_count = media_count + 1
             WHERE id = NEW.entry_id;
         END;

         CREATE TRIGGER IF NOT EXISTS bump_entry_media_count_on_delete
             AFTER DELETE ON media
         BEGIN
             UPDATE entries SET media_count = media_count - 1
             WHERE id = OLD.entry_id;
         END;",
    )?;

    // Phase 6 v2 R7: AI-generated highlights cache. Stored on the entry
    // row itself rather than a side table because the relationship is
    // 1:1, the column is small (~1KB markdown), and the invalidation
    // discipline (clear on content_text change) is easier to enforce
    // when the columns live alongside content_text in the same row.
    // - `ai_highlights`: markdown body. `NULL` means "not generated"
    //   OR "invalidated by a content edit"; the UI distinguishes via
    //   the timestamp.
    // - `ai_highlights_generated_at`: unix seconds. Enables the
    //   "Generated 3 minutes ago" UI string.
    // - `ai_highlights_model_id`: `"{provider}:{chat_model}"` so the
    //   UI can show "Generated by openai:gpt-4o-mini" if the user
    //   wants to confirm provenance, and so a future audit / "show
    //   per-provider summaries" feature has the data.
    // ALTER TABLE ADD COLUMN is idempotent-safe via let _ = (the
    //   second migrate() call returns "duplicate column" which we
    //   ignore — same posture as content_language above).
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN ai_highlights TEXT;");
    let _ =
        conn.execute_batch("ALTER TABLE entries ADD COLUMN ai_highlights_generated_at INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN ai_highlights_model_id TEXT;");

    // Phase 6 v2 R9 v2 (slice 3): track whether `chat_sessions.title` was
    // auto-generated by the title-gen pass so the command can short-circuit
    // when it's already done. Idempotent — `let _` swallows duplicate-column
    // on already-migrated DBs.
    let _ = conn.execute_batch(
        "ALTER TABLE chat_sessions ADD COLUMN title_is_ai_generated INTEGER NOT NULL DEFAULT 0;",
    );

    // Phase 6 v2 R11: AI provider split (generation vs. embedding).
    //
    // The single-slot config is replaced by two independent slots:
    //   ai_gen_*   — chat + image generation (single endpoint + key)
    //   ai_embed_* — embeddings (separate endpoint + key)
    //
    // Per CLAUDE.md dev-mode policy, we wipe rather than migrate — users
    // re-configure on next launch. The list below uses the constants from
    // `ai::provider::settings_keys` (no string literals) so a future
    // rename of a legacy key only has one source of truth. Each name is
    // an `ai_<scalar>` key; feature toggles (`ai_<feature>_enabled`),
    // daily-chat preferences, the `ai_v2_migrated` flag, and the new
    // `ai_gen_*` / `ai_embed_*` rows all share the `ai_` prefix and MUST
    // survive — that's why we delete by exact key, not by prefix.
    //
    // Gated by `ai_v11_provider_split_migrated = "true"` so the wipe
    // fires exactly once per install — without this gate it would
    // re-fire on every launch and silently re-clear any config the user
    // re-entered after a previous run.
    use crate::ai::provider::settings_keys as ai_keys;
    let r11_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [ai_keys::AI_V11_PROVIDER_SPLIT_MIGRATED],
            |r| r.get(0),
        )
        .ok();
    if r11_done.as_deref() != Some("true") {
        for key in [
            ai_keys::PROVIDER,
            ai_keys::ENDPOINT,
            ai_keys::ENDPOINT_CLASS,
            ai_keys::API_KEY,
            ai_keys::CHAT_MODEL,
            ai_keys::EMBEDDING_MODEL,
            ai_keys::IMAGE_MODEL,
            ai_keys::PRIVACY_ACCEPTED_AT,
        ] {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![ai_keys::AI_V11_PROVIDER_SPLIT_MIGRATED, "true"],
        )?;
    }

    // Phase 6 v2 R12: per-preset credential registry.
    //
    // The four per-slot `endpoint` / `endpoint_class` / `api_key` rows
    // (gen, embed, memory_gen, memory_embed — 12 rows total) are replaced
    // by a single per-preset registry: a syncable `ai_provider_endpoints`
    // map plus a non-synced `ai_provider_keyring` map. The legacy
    // generation-only keyring (`ai_gen_api_keyring`) and its quarantine
    // flag (`ai_gen_api_key_legacy_quarantined`) are dead for the same
    // reason — both were superseded by the preset-keyed registry.
    //
    // Per CLAUDE.md dev-mode policy, we wipe rather than migrate. The row
    // keys below are written as string literals, NOT constants — the
    // constants that used to resolve them (`settings_keys::{gen,embed,
    // memory_gen,memory_embed}::{ENDPOINT,ENDPOINT_CLASS,API_KEY}`, and
    // `GEN_API_KEYRING` / `GEN_API_KEY_LEGACY_QUARANTINED`) were deleted
    // once the cutover made them unreachable from any live code path.
    //
    // Gated by `ai_v12_credential_registry_migrated = "true"` so the wipe
    // fires exactly once per install — without this gate it would re-fire
    // on every launch and silently re-clear any config the user re-entered
    // after a previous run.
    let r12_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [ai_keys::AI_V12_CREDENTIAL_REGISTRY_MIGRATED],
            |r| r.get(0),
        )
        .ok();
    if r12_done.as_deref() != Some("true") {
        for key in [
            "ai_gen_endpoint",
            "ai_gen_endpoint_class",
            "ai_gen_api_key",
            "ai_embed_endpoint",
            "ai_embed_endpoint_class",
            "ai_embed_api_key",
            "ai_memory_gen_endpoint",
            "ai_memory_gen_endpoint_class",
            "ai_memory_gen_api_key",
            "ai_memory_embed_endpoint",
            "ai_memory_embed_endpoint_class",
            "ai_memory_embed_api_key",
            "ai_gen_api_keyring",
            "ai_gen_api_key_legacy_quarantined",
        ] {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![ai_keys::AI_V12_CREDENTIAL_REGISTRY_MIGRATED, "true"],
        )?;
    }

    // Drop the deprecated `ai_smart_summaries_enabled` flag — collapsed
    // into `ai_title_suggestions_enabled` (2026-05-15). The Smart
    // Summaries toggle never actually drove an auto-on-save path; it
    // only gated the editor's Suggest-title pill, which is now owned by
    // Title Generation. Idempotent: the DELETE no-ops on DBs that
    // never had the row.
    conn.execute(
        "DELETE FROM settings WHERE key = 'ai_smart_summaries_enabled'",
        [],
    )?;

    // ── Emotions v2 (2026-05-15) — collapse 8 emojis + 1-5 intensity ─────
    //
    // Per CLAUDE.md dev-mode policy + explicit user confirmation: wipe all
    // existing emotion tags and drop the `emotion_intensity` column. The
    // new shape is a single `emotion` column carrying one of
    // 'good' | 'neutral' | 'bad' | NULL.
    //
    // Gated by `emotions_v2_3_state_migrated = "true"` so the wipe fires
    // exactly once per install (matches the R11 gate pattern above). Without
    // this gate, every launch would re-null any emotion the user re-tagged.
    //
    // SQLite ≥ 3.35 supports `ALTER TABLE ... DROP COLUMN`. `emotion_intensity`
    // does not appear in any index, trigger, or FTS5 column list (verified
    // by grep at refactor time), so DROP COLUMN is safe.
    let emotions_v2_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["emotions_v2_3_state_migrated"],
            |r| r.get(0),
        )
        .ok();
    if emotions_v2_done.as_deref() != Some("true") {
        // The wipe + drop both depend on the legacy `emotion_intensity`
        // column actually existing — a fresh DB built from the post-refactor
        // CREATE TABLE has neither legacy data nor the column. Probing once
        // and short-circuiting keeps the migration idempotent across both
        // legacy and fresh DBs (and skips it for synthetic test fixtures
        // that build a partial entries table without `emotion`).
        let has_intensity: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'emotion_intensity'",
            [],
            |r| r.get(0),
        )?;
        if has_intensity > 0 {
            // Force the FTS5 external-content index to sync with `entries`
            // before we touch any rows. The FTS5 triggers added earlier in
            // this migrate() pass would otherwise issue `delete` ops against
            // rowids the freshly-created FTS table has no record of, which
            // SQLite reports as "database disk image is malformed".
            conn.execute(
                "INSERT INTO entries_fts(entries_fts) VALUES ('rebuild')",
                [],
            )?;
            conn.execute("UPDATE entries SET emotion = NULL", [])?;
            conn.execute_batch("ALTER TABLE entries DROP COLUMN emotion_intensity")?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["emotions_v2_3_state_migrated", "true"],
        )?;
    }

    // ── Pagination indexes (2026-05-15) ──────────────────────────────────────
    // Composite indexes that support keyset-paginated list queries for entries
    // and media. All use `CREATE INDEX IF NOT EXISTS` (idempotent; safe to run
    // on every startup without a gate flag because these are purely additive).
    //
    // Partial indexes (`WHERE is_deleted = 0`) exclude soft-deleted rows so
    // the planner never visits them during normal list queries. The secondary
    // `id DESC` key breaks ties deterministically so pages cannot skip or
    // repeat a row when two entries share the same primary sort value.
    conn.execute_batch(
        "
        -- 1. Default sort: all non-deleted entries by date (newest first).
        CREATE INDEX IF NOT EXISTS idx_entries_entry_date_desc
            ON entries(entry_date DESC, id DESC)
            WHERE is_deleted = 0;

        -- 2. Per-journal sort: entries filtered to one journal, newest first.
        CREATE INDEX IF NOT EXISTS idx_entries_journal_entry_date
            ON entries(journal_id, entry_date DESC, id DESC)
            WHERE is_deleted = 0;

        -- 3. Favorites sort: only favorite entries, newest first.
        --    Partial on `is_favorite = 1` so the index is tiny and the
        --    planner can use it without reading the full entries table.
        CREATE INDEX IF NOT EXISTS idx_entries_favorite_entry_date
            ON entries(is_favorite, entry_date DESC, id DESC)
            WHERE is_deleted = 0 AND is_favorite = 1;

        -- 4. Recently-updated sort: supports the 'Last edited' sort pill.
        CREATE INDEX IF NOT EXISTS idx_entries_updated_at
            ON entries(updated_at DESC, id DESC)
            WHERE is_deleted = 0;

        -- 5. Media gallery sort: all media ordered by insertion time, newest first.
        --    No partial index here — media rows are hard-deleted, not soft-deleted.
        CREATE INDEX IF NOT EXISTS idx_media_created_at
            ON media(created_at DESC, id DESC);
        ",
    )?;

    // Backfill covers for entries that already have image media but were
    // created before the auto-set logic shipped. Idempotent — only touches
    // entries where `cover_media_id IS NULL`.
    crate::db::queries::backfill_entry_covers(conn)?;

    // Insert a default journal if none exists
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM journals", [], |row| row.get(0))?;
    if count == 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO journals (id, name, color, created_at, updated_at, sort_order, is_initial_placeholder)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            rusqlite::params![id, "My Journal", "#4F46E5", now, now, 0],
        )?;
    }

    // Materialize the singleton once during migration. Read paths stay pure,
    // while every writer can rely on an id=1 row being present.
    conn.execute(
        "INSERT OR IGNORE INTO user_persona (id, updated_at) VALUES (1, 0)",
        [],
    )?;

    // Idempotent content seeds (Chunk F — redesign).
    seeds::ensure_predefined_templates(conn)?;

    // Phase 3 follow-up: durable flag for "user has finalized the entry's
    // date" so the multi-EXIF date suggestion modal doesn't re-pop every
    // time the entry is reopened. Set to 1 when the user (a) manually
    // edits the date pill, (b) confirms a date in the suggestion modal,
    // or (c) closes / cancels the modal. The frontend reads this and
    // suppresses the auto-open. Idempotent via `let _`.
    let _ = conn
        .execute_batch("ALTER TABLE entries ADD COLUMN entry_date_user_edited INTEGER DEFAULT 0;");

    // ── Voice memos v2 (2026-05-20) ──────────────────────────────────────
    //
    // Voice memos used to be inserted inline into the editor (TipTap audio
    // node + `insertion_mode = 'inline'`). They now live only as attachments
    // in the attachment strip. Per CLAUDE.md dev-mode policy + explicit user
    // confirmation, wipe legacy audio media rows so existing inline TipTap
    // nodes don't render stale broken players.
    //
    // Gated by `voice_memos_v2_attachments_only_migrated` so the wipe fires
    // exactly once per install.
    let voice_v2_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["voice_memos_v2_attachments_only_migrated"],
            |r| r.get(0),
        )
        .ok();
    if voice_v2_done.as_deref() != Some("true") {
        conn.execute("DELETE FROM media WHERE file_type LIKE 'audio/%'", [])?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["voice_memos_v2_attachments_only_migrated", "true"],
        )?;
    }

    // ── streak_cache.updated_at (2026-05-21, Stage 7) ─────────────────────
    let _ = conn.execute_batch(
        "ALTER TABLE streak_cache ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
    );

    // ── chat_sessions.is_deleted (2026-05-21, Stage 6) ────────────────────
    let _ = conn.execute_batch(
        "ALTER TABLE chat_sessions ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;",
    );

    // ── Daily Chat RAG columns (2026-07-25) ────────────────────────────────
    let _ = conn
        .execute_batch("ALTER TABLE chat_sessions ADD COLUMN used_rag INTEGER NOT NULL DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN attachments TEXT;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN source_entry_ids TEXT;");

    // ── Daily Chat memory ids (2026-07-30) ─────────────────────────────────
    // Persists which memory_items were folded into an assistant turn's
    // prompt, mirroring source_entry_ids so the "N memories used" chip
    // survives a reload instead of living only in transient turn state.
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN memory_ids TEXT;");

    // ── per-message AI metadata on chat_messages ──────────────────────────
    // Nullable columns; existing rows stay NULL (no backfill). Dev DBs that
    // already have the CREATE TABLE columns swallow the duplicate-column error.
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN model_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN provider_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN endpoint_class TEXT;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN tokens_in INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN tokens_out INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE chat_messages ADD COLUMN latency_ms INTEGER;");

    // ── Daily Chat → Entry conversion watermark (2026-07-28) ───────────────
    // Nullable, no FK on converted_entry_id (dangling ids handled at read time —
    // do NOT add REFERENCES/ON DELETE, it would reorder sync writes). The
    // partial index backs the entry back-reference banner lookup.
    let _ = conn.execute_batch("ALTER TABLE chat_sessions ADD COLUMN converted_entry_id TEXT;");
    let _ =
        conn.execute_batch("ALTER TABLE chat_sessions ADD COLUMN converted_through_seq INTEGER;");
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_chat_sessions_converted_entry \
         ON chat_sessions(converted_entry_id) WHERE converted_entry_id IS NOT NULL;",
    );

    // ── Daily Chat pin-to-top (2026-08-04) ─────────────────────────────────
    // Nullable; existing rows stay NULL (unpinned), so no backfill. No index:
    // the pin ordering (`pinned_at DESC, updated_at DESC, id DESC`) cannot be
    // served by `idx_chat_sessions_updated`, so SQLite full-sorts the
    // non-deleted sessions on every page query. That is acceptable at this
    // scale (page size 10, session counts in the hundreds).
    let _ = conn.execute_batch("ALTER TABLE chat_sessions ADD COLUMN pinned_at INTEGER;");

    // ── location_aliases sync columns (2026-05-21, Stage 5) ───────────────
    let _ = conn.execute_batch(
        "ALTER TABLE location_aliases ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE location_aliases ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE location_aliases ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;",
    );

    // ── templates.updated_at + templates.is_deleted (2026-05-21, Stage 4) ─
    let _ = conn
        .execute_batch("ALTER TABLE templates ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
    let _ = conn
        .execute_batch("ALTER TABLE templates ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;");

    // ── tags.updated_at + tags.is_deleted (2026-05-21, Stage 2) ───────────
    //
    // Tags now sync as a first-class channel (`{device}/tags.bin`), so
    // they need a per-row LWW key and a tombstone column. Existing rows
    // pick up DEFAULT 0 / DEFAULT 0; the `_ =` swallows the duplicate-
    // column error on already-migrated DBs.
    let _ =
        conn.execute_batch("ALTER TABLE tags ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");
    let _ =
        conn.execute_batch("ALTER TABLE tags ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;");

    // ── journal_sync_state (2026-05-21, Stage 3) ──────────────────────────
    //
    // Journals now sync as a first-class channel (each as its own
    // `{device}/journals/{id}.bin` payload). Mirrors `sync_state` for
    // entries — one row per journal, monotonic local_version, last
    // synced timestamp + status. ON DELETE CASCADE fires only on hard
    // delete; soft-deletes leave the row intact so the tombstone can
    // still be pushed.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS journal_sync_state (
            journal_id     TEXT PRIMARY KEY REFERENCES journals(id) ON DELETE CASCADE,
            local_version  INTEGER NOT NULL DEFAULT 1,
            synced_version INTEGER NOT NULL DEFAULT 0,
            last_synced_at INTEGER,
            sync_status    TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_journal_sync_state_pending
            ON journal_sync_state(sync_status) WHERE sync_status = 'pending';",
    )?;

    // One-shot: mark every existing journal pending so the first sync
    // after this migration republishes them via the new channel.
    let journal_sync_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["sync_v3_journals_first_push"],
            |r| r.get(0),
        )
        .ok();
    if journal_sync_done.as_deref() != Some("true") {
        // `WHERE true` disambiguates the parser: without it, SQLite reads
        // `FROM journals ON CONFLICT` as if ON CONFLICT were a JOIN.
        conn.execute(
            "INSERT INTO journal_sync_state (journal_id, local_version, sync_status)
             SELECT id, 1, 'pending' FROM journals WHERE true
             ON CONFLICT(journal_id) DO UPDATE SET
                 local_version = journal_sync_state.local_version + 1,
                 sync_status   = 'pending'",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["sync_v3_journals_first_push", "true"],
        )?;
    }

    // ── sync_push_state (2026-07-16, surface hash store) ───────────────────
    //
    // Content-hash ledger for whole-table sync surfaces (tags, settings,
    // templates, …). One row per surface name; absent row means default-
    // dirty so a fresh device always re-pushes. No index — ≤8 rows, PK
    // lookup only. See plan 2026-07-16-sync-change-tracking Phase 3.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_push_state (
            surface      TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            updated_at   INTEGER NOT NULL
        );",
    )?;

    // ── sync_pull_state (2026-07-28, peer manifest revision store) ─────────
    //
    // Last successfully fetched revision for each peer/surface manifest.
    // An absent row means the next pull must fetch the manifest body. The
    // composite key keeps revision state isolated between peer devices while
    // allowing future pull surfaces alongside metadata.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_pull_state (
            peer_device_id TEXT NOT NULL,
            surface        TEXT NOT NULL,
            revision       TEXT NOT NULL,
            fetched_at     INTEGER NOT NULL,
            PRIMARY KEY (peer_device_id, surface)
        );",
    )?;

    // ── settings.updated_at (2026-05-21, Stage 1 of full-state sync) ──────
    //
    // Dev DBs created before this change have a 2-column `settings` table
    // (key, value) and no per-key timestamp. Adding the column with a
    // default of 0 makes every existing row "ancient" — any subsequent
    // write via `set_setting` bumps it, and any pulled peer setting with
    // a real timestamp strictly outranks the local 0 (LWW), which is the
    // behavior we want on first sync after upgrade.
    let _ = conn
        .execute_batch("ALTER TABLE settings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;");

    // Tombstone marker for syncable settings deletions (verifier disable, etc.).
    // NULL = active; non-NULL = logically deleted but row ships in settings.bin.
    let _ = conn.execute_batch("ALTER TABLE settings ADD COLUMN deleted_at INTEGER;");

    // ── Sync v2 media + journal manifest (2026-05-21) ─────────────────────
    //
    // Pre-fix entries were synced without their journal color and
    // without a media manifest, so any device pulling them rendered broken
    // images and a default-colored journal. Now that `EntryMetadata`
    // carries this state, mark every existing entry as pending so the next
    // sync re-pushes them with the new payload shape. Gated by a settings
    // flag so it fires exactly once per install.
    let sync_v2_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["sync_v2_media_and_journal_repushed"],
            |r| r.get(0),
        )
        .ok();
    if sync_v2_done.as_deref() != Some("true") {
        // One-shot republish — inline SQL so the migration is
        // self-contained (no dependency on a sibling module).
        conn.execute(
            "INSERT INTO sync_state (entry_id, local_version, sync_status)
             SELECT id, 1, 'pending' FROM entries WHERE is_deleted = 0
             ON CONFLICT(entry_id) DO UPDATE SET
                 local_version = sync_state.local_version + 1,
                 sync_status   = 'pending'",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["sync_v2_media_and_journal_repushed", "true"],
        )?;
    }

    // ai_audit_log sync migration: the original schema used an `id INTEGER
    // PRIMARY KEY AUTOINCREMENT` and was device-local. The new schema keys
    // rows by `(device_id, local_seq)` so peer rows can be ingested without
    // PK collisions. Dev mode: drop the old table outright on first
    // migration (CLAUDE.md authorises wiping audit history pre-release).
    //
    // The migration is gated on a one-shot settings flag rather than a
    // pragma_table_info shape sniff: the latter silently re-drops the
    // table on any transient probe failure or branch roll-back, while a
    // flag is set once after the rebuild and never re-evaluated.
    let ai_audit_v2_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["ai_audit_log_v2_composite_pk"],
            |r| r.get(0),
        )
        .ok();
    if ai_audit_v2_done.as_deref() != Some("true") {
        conn.execute_batch(
            "DROP TABLE IF EXISTS ai_audit_log;
             CREATE TABLE ai_audit_log (
                device_id       TEXT    NOT NULL,
                local_seq       INTEGER NOT NULL,
                created_at      INTEGER NOT NULL,
                feature         TEXT    NOT NULL,
                operation       TEXT    NOT NULL,
                provider_id     TEXT    NOT NULL,
                model_id        TEXT    NOT NULL,
                endpoint_host   TEXT    NOT NULL,
                endpoint_class  TEXT    NOT NULL,
                payload_bytes   INTEGER NOT NULL,
                latency_ms      INTEGER NOT NULL,
                status          TEXT    NOT NULL,
                error_code      TEXT,
                tokens_in       INTEGER,
                tokens_out      INTEGER,
                device_name     TEXT    NOT NULL DEFAULT '',
                PRIMARY KEY (device_id, local_seq)
             );
             CREATE INDEX IF NOT EXISTS ai_audit_log_created_at_idx ON ai_audit_log(created_at);
             CREATE INDEX IF NOT EXISTS ai_audit_log_provider_idx   ON ai_audit_log(provider_id);
             CREATE INDEX IF NOT EXISTS ai_audit_log_feature_idx    ON ai_audit_log(feature);
             CREATE INDEX IF NOT EXISTS ai_audit_log_device_idx     ON ai_audit_log(device_id);",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["ai_audit_log_v2_composite_pk", "true"],
        )?;
        // Fresh rebuild already has device_name — mark the follow-up migration done.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["ai_audit_log_device_name", "true"],
        )?;
    }

    // Snapshot machine display name onto each audit row (denormalized at
    // insert). Existing DBs get an empty default; new inserts fill it from
    // devices.name. Active-dev: no backfill of historical rows.
    let ai_audit_device_name_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["ai_audit_log_device_name"],
            |r| r.get(0),
        )
        .ok();
    if ai_audit_device_name_done.as_deref() != Some("true") {
        // IF NOT EXISTS is not available for ADD COLUMN on all SQLite builds
        // we care about; the flag gate makes this one-shot.
        let has_col: bool = conn
            .prepare("PRAGMA table_info(ai_audit_log)")
            .ok()
            .and_then(|mut stmt| {
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(1))
                    .ok()?
                    .filter_map(|r| r.ok())
                    .any(|name| name == "device_name");
                Some(rows)
            })
            .unwrap_or(false);
        if !has_col {
            conn.execute(
                "ALTER TABLE ai_audit_log ADD COLUMN device_name TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["ai_audit_log_device_name", "true"],
        )?;
    }

    // ai_reviews period PK: the original schema keyed rows by
    // (kind, period_start, period_end, model_id) so each model kept its
    // own cache entry. The new schema is one review per period
    // (kind, period_start, period_end); model_id stays as a non-key
    // column. Dev mode: drop the old table outright on first migration
    // (CLAUDE.md authorises wiping cached reviews pre-release).
    //
    // Gated on a one-shot settings flag rather than a pragma_table_info
    // shape sniff: the latter silently re-drops the table on any
    // transient probe failure or branch roll-back, while a flag is set
    // once after the rebuild and never re-evaluated.
    let ai_reviews_period_pk_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["ai_reviews_period_pk"],
            |r| r.get(0),
        )
        .ok();
    if ai_reviews_period_pk_done.as_deref() != Some("true") {
        conn.execute_batch(
            "DROP TABLE IF EXISTS ai_reviews;
             CREATE TABLE ai_reviews (
                kind            TEXT    NOT NULL,
                period_start    INTEGER NOT NULL,
                period_end      INTEGER NOT NULL,
                model_id        TEXT    NOT NULL,
                result_json     TEXT    NOT NULL,
                entry_count     INTEGER NOT NULL,
                created_at      INTEGER NOT NULL,
                PRIMARY KEY (kind, period_start, period_end)
             );
             CREATE INDEX IF NOT EXISTS ai_reviews_created_at_idx ON ai_reviews(created_at);",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["ai_reviews_period_pk", "true"],
        )?;
    }

    // ── encryption_enabled cleanup (Phase 2 — 2026-05-20) ───────────────────
    //
    // The legacy `encryption_enabled` settings row was used by the Phase 1
    // migration shim to derive `encryption_mode`. All call-sites have been
    // updated; delete the stale row so it doesn't linger in existing DBs.
    // This is idempotent — DELETE on a non-existent key is a no-op.
    conn.execute("DELETE FROM settings WHERE key = 'encryption_enabled'", [])?;
    // Also clean up the v1-migration sentinel — it's no longer needed.
    conn.execute(
        "DELETE FROM settings WHERE key = 'encryption_mode_v1_migrated'",
        [],
    )?;

    // Invisible multi-vault (2026-08-12): table + vault_id columns are created
    // above. Do NOT delete settings.invisible_lock_verifier here — Phase 1–2
    // still use get/set_invisible_lock_verifier for legacy commands until
    // Phase 3 removes that IPC. Unconditional DELETE would strand is_invisible
    // flags across restarts. Hard cut for users = wipe app data (plan README);
    // no PHC→vault migration.

    // ── Phase N (2026-05-26): per-device keyring V2 tables ────────────────────
    //
    // Codex review follow-up: drop and recreate Phase 1 tables with CHECK
    // constraints. Safe in dev mode — these tables are empty in any real
    // install (Phase 2 hasn't shipped yet and no production data exists).
    // `CREATE TABLE IF NOT EXISTS` cannot add CHECK constraints to an existing
    // table, so we drop first.
    //
    // Gated by `keyring_v2_check_constraints_applied_v2` so the wipe fires ONCE
    // per dev DB. Without this gate the DROP statements would fire on every
    // app launch — fine for empty tables today, but catastrophic the moment
    // Phase 2 starts writing data. Pattern matches `ai_audit_log_v2_composite_pk`
    // (line 842) and `voice_memos_v2_attachments_only_migrated` (line 690).
    // The suffix was bumped from `_applied` to `_applied_v2` to force a
    // one-time re-run on existing dev DBs so they pick up the new CHECK list
    // that includes `enumerate_stragglers`.
    let keyring_v2_check_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            ["keyring_v2_check_constraints_applied_v2"],
            |r| r.get(0),
        )
        .ok();
    if keyring_v2_check_done.as_deref() != Some("true") {
        conn.execute_batch(
            "
        -- Drop Phase 1 tables and their indexes so we can recreate with CHECK constraints.
        DROP TABLE IF EXISTS rotation_job_items;
        DROP TABLE IF EXISTS rotation_job;
        DROP TABLE IF EXISTS devices;
        DROP TABLE IF EXISTS pending_first_time_setup;
        DROP INDEX IF EXISTS idx_rotation_job_items_status;
        DROP INDEX IF EXISTS idx_devices_one_current;

        -- Known devices registered on this cloud folder. One row per device,
        -- keyed by UUID v4. `is_current = 1` marks the device running this code.
        CREATE TABLE IF NOT EXISTS devices (
            device_id     TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            last_seen_at  INTEGER NOT NULL,
            is_current    INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0, 1)),
            is_revoked    INTEGER NOT NULL DEFAULT 0 CHECK(is_revoked IN (0, 1))
        );

        -- Resumable key-rotation state machine. A rotation is triggered by
        -- a Revoke-device action or an explicit manual rotation. States:
        --   enumerate → reencrypt → commit_local → enumerate_stragglers
        --   → publish_keyring → done | aborted
        -- `enumerate_stragglers` is a Phase 5 sub-step: after commit_local the
        -- publisher re-enumerates files modified after started_at and re-encrypts
        -- any that were missed during the main reencrypt pass.
        -- At most one active rotation exists at a time (enforced by the engine).
        CREATE TABLE IF NOT EXISTS rotation_job (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            state             TEXT NOT NULL CHECK(state IN (
                                  'enumerate', 'reencrypt', 'commit_local',
                                  'enumerate_stragglers',
                                  'publish_keyring', 'done', 'aborted')),
            old_fingerprint   TEXT NOT NULL,
            new_fingerprint   TEXT NOT NULL,
            old_epoch         INTEGER NOT NULL,
            new_epoch         INTEGER NOT NULL,
            -- nullable: the device the user clicked Revoke on (if applicable)
            revoked_device_id TEXT,
            started_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            error             TEXT
        );

        -- Per-envelope items inside a rotation job. One row per entry/media
        -- file that must be re-encrypted. Tracks progress so a crash mid-rotation
        -- can be resumed from the last successful item.
        CREATE TABLE IF NOT EXISTS rotation_job_items (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rotation_id   INTEGER NOT NULL REFERENCES rotation_job(id) ON DELETE CASCADE,
            envelope_kind TEXT NOT NULL CHECK(envelope_kind IN ('entry', 'media', 'blob', 'version')),
            envelope_id   TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending', 'done', 'failed')),
            error         TEXT,
            UNIQUE(rotation_id, envelope_id)
        );

        CREATE INDEX IF NOT EXISTS idx_rotation_job_items_status
            ON rotation_job_items(rotation_id, status);

        -- Survivor table for crash recovery between mnemonic reveal and the
        -- user completing the 4-word confirmation challenge. The mnemonic is
        -- stored plaintext here because the DB is protected by SQLCipher (at-rest
        -- AES-256 via the master key). Rows are deleted as soon as the
        -- confirmation succeeds (or the user cancels setup).
        -- SECURITY NOTE: `mnemonic` is stored as plaintext TEXT. This is acceptable
        -- because:
        --   (a) The pending row exists only between begin_ and confirm_first_time_setup,
        --       which typically completes in seconds.
        --   (b) At this point in setup, SQLCipher encryption is not yet applied
        --       (the DB is bootstrap-encrypted with the zero key), so per-row encryption
        --       would not add meaningful protection anyway.
        --   (c) On crash recovery the mnemonic is redisplayed so the user can retry.
        -- The row is deleted immediately after confirm_first_time_setup succeeds.
        CREATE TABLE IF NOT EXISTS pending_first_time_setup (
            setup_id          TEXT PRIMARY KEY,
            mnemonic          TEXT NOT NULL,
            wrapped_master    TEXT NOT NULL,
            kek_salt          TEXT NOT NULL,
            recovery_wrapped  TEXT NOT NULL,
            device_id         TEXT NOT NULL,
            device_name       TEXT NOT NULL,
            challenge_indices TEXT NOT NULL,
            created_at        INTEGER NOT NULL
        );

        -- Enforce at-most-one current device at the DB level. The partial index
        -- covers only rows where is_current = 1, so non-current rows are not
        -- constrained by it.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_one_current
            ON devices(is_current) WHERE is_current = 1;
        ",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["keyring_v2_check_constraints_applied_v2", "true"],
        )?;
    }

    // Authoritative Google Drive recovery jobs survive process restarts and
    // remain active after a failed step so the same job can resume. Completed
    // rows are retained for diagnostics, while the partial unique index
    // enforces that only one non-completed recovery can exist at a time.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            operation           TEXT NOT NULL
                                CHECK(operation IN ('local_to_cloud', 'cloud_to_local')),
            phase               TEXT NOT NULL DEFAULT 'created'
                                CHECK(phase IN (
                                    'created', 'preflight', 'backup', 'fenced',
                                    'transfer', 'verify', 'commit', 'finalize',
                                    'fence_release_pending'
                                )),
            status              TEXT NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('pending', 'running', 'failed', 'completed')),
            recovery_generation INTEGER NOT NULL CHECK(recovery_generation > 0),
            backup_path         TEXT,
            staging_path        TEXT,
            verification_binding TEXT NOT NULL DEFAULT '{}',
            verified_counts     TEXT NOT NULL DEFAULT '{}',
            last_error          TEXT,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_recovery_jobs_one_active
            ON sync_recovery_jobs((1)) WHERE status != 'completed';
        CREATE INDEX IF NOT EXISTS idx_sync_recovery_jobs_latest
            ON sync_recovery_jobs(id DESC);",
    )?;
    let _ = conn.execute_batch(
        "ALTER TABLE sync_recovery_jobs ADD COLUMN verification_binding TEXT NOT NULL DEFAULT '{}';",
    );

    // ── Ask Journal removal (2026-07-26) ──────────────────────────────────
    // Ask Journal was replaced by Daily Chat's retrieval-augmented replies;
    // its history table is dropped unconditionally on dev DBs per CLAUDE.md's
    // no-back-compat policy — no migration shim, `DROP TABLE IF EXISTS` is a
    // no-op once the table is gone.
    conn.execute_batch("DROP TABLE IF EXISTS ask_journal_queries;")?;

    // ── Embedding Cost Guardrails Phase 1 (2026-07-12) ────────────────────
    //
    // Drop the old entry-level `entries_embeddings` table for dev DBs that
    // created it before this migration. `entry_embedding_chunks` +
    // `entry_embedding_jobs` (created earlier in this function) replace it —
    // chunk-only, no migration shim, per CLAUDE.md dev-mode policy. Safe to
    // run unconditionally on every launch: `DROP TABLE IF EXISTS` is a no-op
    // once the table is gone, and we never want it back.
    conn.execute_batch("DROP TABLE IF EXISTS entries_embeddings;")?;

    // ── Remove journal emoji icon (2026-07-28) ─────────────────────────────
    // Journals are now identified by `color` only — the free-text emoji
    // `icon` field is dropped entirely. SQLite ≥ 3.35 supports
    // `ALTER TABLE ... DROP COLUMN`. Wrapped in `let _ =` so DBs that never
    // had the column (fresh installs, or a DB that already ran this
    // migration) ignore the "no such column" error, matching the
    // `auto_tag_id` drop pattern above.
    let _ = conn.execute_batch("ALTER TABLE journals DROP COLUMN icon;");

    Ok(())
}

/// Pre-`weekdays` dev DBs created `reminders` with `frequency TEXT` and
/// `weekday INTEGER` columns. The new schema replaces those with a single
/// `weekdays INTEGER` bitmask. Detect the old shape and drop the table so the
/// `CREATE TABLE IF NOT EXISTS` below rebuilds it cleanly.
///
/// Per CLAUDE.md dev-mode policy: there is no production data to migrate, so
/// dropping is acceptable. This guard exists so an existing dev DB doesn't
/// silently keep the old shape (which would break `INSERT` statements that
/// now reference `weekdays`).
fn drop_reminders_if_drifted(conn: &Connection) -> Result<()> {
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='reminders'",
        [],
        |r| r.get(0),
    )?;
    if table_exists == 0 {
        return Ok(());
    }
    let has_weekdays: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('reminders') WHERE name='weekdays'",
        [],
        |r| r.get(0),
    )?;
    if has_weekdays == 0 {
        log::warn!(
            "reminders table is on the old schema (frequency/weekday). Dropping \
             and recreating with the new weekdays bitmask column. Existing \
             reminders will be lost (dev mode)."
        );
        conn.execute_batch("DROP TABLE IF EXISTS reminders;")?;
    }
    Ok(())
}

/// Drop `entries_fts` and its triggers when they don't match the current
/// target, so the `CREATE VIRTUAL TABLE` in `migrate` can recreate them cleanly.
/// Two kinds of drift are detected:
///   1. Wrong indexed-column count (pre-Phase-2 one-column DBs).
///   2. Old tokenizer — anything without `remove_diacritics 2`, i.e. the
///      default-tokenizer DBs that predate accent-insensitive search.
/// Returns `true` when it dropped the table (so the caller re-`'rebuild'`s the
/// index), `false` when the table is absent or already correct.
fn drop_fts_if_drifted(conn: &Connection) -> Result<bool> {
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries_fts'",
        [],
        |r| r.get(0),
    )?;
    if table_exists == 0 {
        return Ok(false);
    }
    // `PRAGMA table_info` on an FTS5 virtual table lists its indexed columns.
    let column_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('entries_fts')",
        [],
        |r| r.get(0),
    )?;
    const EXPECTED_FTS_COLUMNS: i64 = 2; // `title_fold` + `content_fold`
                                         // The stored `CREATE VIRTUAL TABLE` SQL carries the tokenizer clause; a DB
                                         // built before accent-insensitive search has no `remove_diacritics 2`.
    let create_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries_fts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let tokenizer_drifted = !create_sql.contains("remove_diacritics 2");

    if column_count != EXPECTED_FTS_COLUMNS || tokenizer_drifted {
        log::warn!(
            "entries_fts drifted (columns={column_count}, \
             tokenizer_drifted={tokenizer_drifted}). Dropping the virtual table \
             and triggers so migrate() recreates the accent-folded shape."
        );
        conn.execute_batch(
            "
            DROP TRIGGER IF EXISTS entries_ai;
            DROP TRIGGER IF EXISTS entries_au;
            DROP TRIGGER IF EXISTS entries_ad;
            DROP TABLE IF EXISTS entries_fts;
            ",
        )?;
        return Ok(true);
    }
    Ok(false)
}

/// Backfill the `title_fold` / `content_fold` generated columns onto an
/// existing `entries` table that predates accent-insensitive search. No-op on a
/// fresh DB (the table doesn't exist yet — the `CREATE TABLE` in `migrate`
/// defines them inline) and on an already-migrated DB (columns present). The
/// columns are VIRTUAL, the only generated kind SQLite allows `ALTER TABLE ADD
/// COLUMN` to introduce.
fn add_fold_columns_if_missing(conn: &Connection) -> Result<()> {
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries'",
        [],
        |r| r.get(0),
    )?;
    if table_exists == 0 {
        return Ok(());
    }
    // VIRTUAL generated columns are hidden from `pragma_table_info`; only
    // `pragma_table_xinfo` lists them, so probe that or the guard never trips
    // and the ALTER re-runs on every migrate (duplicate-column error).
    let has_fold: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_xinfo('entries') WHERE name='content_fold'",
        [],
        |r| r.get(0),
    )?;
    if has_fold == 0 {
        conn.execute_batch(
            "ALTER TABLE entries ADD COLUMN title_fold TEXT GENERATED ALWAYS AS
                 (replace(replace(title, 'đ', 'd'), 'Đ', 'D')) VIRTUAL;
             ALTER TABLE entries ADD COLUMN content_fold TEXT GENERATED ALWAYS AS
                 (replace(replace(content_text, 'đ', 'd'), 'Đ', 'D')) VIRTUAL;",
        )?;
    }
    Ok(())
}

/// Backfill the `from_chat` flag onto an existing `entries` table that
/// predates the daily-chat-origin indicator. No-op on a fresh DB (the column
/// is defined inline in `CREATE TABLE` inside `migrate`) and on an
/// already-migrated DB (column present). Existing rows default to 0 (never
/// from chat) which is correct: there is no reliable way to retroactively
/// detect chat-origin on legacy rows, and they simply render without the icon.
fn add_from_chat_column_if_missing(conn: &Connection) -> Result<()> {
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries'",
        [],
        |r| r.get(0),
    )?;
    if table_exists == 0 {
        return Ok(());
    }
    let has_from_chat: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name='from_chat'",
        [],
        |r| r.get(0),
    )?;
    if has_from_chat == 0 {
        conn.execute_batch("ALTER TABLE entries ADD COLUMN from_chat INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        migrate(&conn).expect("migrate");
        conn
    }

    #[test]
    fn migrate_empty_db() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(migrate(&conn).is_ok());
    }

    #[test]
    fn migrate_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // calling twice should not fail
        assert!(migrate(&conn).is_ok());
    }

    #[test]
    fn user_persona_is_a_structural_singleton() {
        let conn = setup();
        assert!(
            conn.execute(
                "INSERT INTO user_persona (id, updated_at) VALUES (2, 200)",
                [],
            )
            .is_err(),
            "the database must reject every singleton id other than 1"
        );
        assert!(
            conn.execute(
                "INSERT INTO user_persona (id, updated_at) VALUES (1, 200)",
                [],
            )
            .is_err(),
            "a second singleton row must fail its primary-key constraint"
        );
    }

    #[test]
    fn migrate_adds_from_chat_column_on_fresh_db() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name='from_chat'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 1, "from_chat column exists on fresh DB");
        // Default must be 0 so plain entries don't show the chat icon.
        let default_val: i64 = conn
            .query_row("SELECT from_chat FROM entries LIMIT 1", [], |r| r.get(0))
            .ok()
            .unwrap_or(0);
        assert_eq!(default_val, 0, "from_chat defaults to 0");
    }

    #[test]
    fn migrate_adds_awaiting_compression_column_to_media() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('media') WHERE name='awaiting_compression'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 1, "awaiting_compression column exists on fresh DB");
        let (notnull, dflt): (i64, Option<String>) = conn
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('media') WHERE name='awaiting_compression'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(notnull, 1, "awaiting_compression is NOT NULL");
        assert_eq!(
            dflt.as_deref(),
            Some("0"),
            "awaiting_compression defaults to 0"
        );
    }

    #[test]
    fn migrate_backfills_from_chat_column_on_existing_dev_db() {
        // Exercise the idempotent ALTER helper directly against a minimal
        // legacy `entries` table. The full migrate() FTS rebuild path on a
        // legacy table is covered by
        // migrate_backfills_second_lock_columns_on_existing_dev_db; here we
        // isolate just the from_chat backfill + idempotency guard.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entries (
                id TEXT PRIMARY KEY NOT NULL,
                title TEXT
            );
            INSERT INTO entries (id, title) VALUES ('e1', 'Legacy');",
        )
        .unwrap();

        add_from_chat_column_if_missing(&conn).unwrap();

        let has_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name='from_chat'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_col, 1, "ALTER backfilled from_chat onto legacy table");
        let legacy_val: i64 = conn
            .query_row("SELECT from_chat FROM entries WHERE id='e1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(legacy_val, 0, "legacy entries backfill to from_chat = 0");
        // Re-running the helper must not error (idempotent guard probes
        // pragma_table_info before ALTERing).
        add_from_chat_column_if_missing(&conn).unwrap();
    }

    #[test]
    fn migrate_fresh_db_has_no_journal_icon_column() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let has_icon: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('journals') WHERE name = 'icon'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_icon, 0, "journals.icon should not exist on a fresh DB");
    }

    #[test]
    fn migrate_drops_journal_icon_column_on_legacy_db() {
        // Simulate a pre-refactor dev DB that still has the `icon` column.
        // Mirrors the fixture shape used by
        // `migrate_backfills_second_lock_columns_on_existing_dev_db` below
        // (journals + entries + entries_fts) since `migrate()`'s FTS-drift
        // and fold-column helpers run before the journals table is touched
        // and expect `entries`/`entries_fts` to already be in a known shape
        // when present.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE journals (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                color TEXT,
                icon TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0
             );
             CREATE TABLE entries (
                id TEXT PRIMARY KEY NOT NULL,
                journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
                title TEXT,
                preview_text TEXT,
                content_text TEXT,
                entry_date INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_favorite INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0
             );
             CREATE VIRTUAL TABLE entries_fts USING fts5(
                title,
                content_text,
                content='entries',
                content_rowid='rowid'
             );
             INSERT INTO journals (id, name, color, icon, created_at, updated_at)
                VALUES ('j1', 'J', '#fff', '📓', 0, 0);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let has_icon: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('journals') WHERE name = 'icon'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_icon, 0, "icon column should be dropped");
        // `color` is now the sole journal identity field, so assert the whole
        // row survives the table-rebuild that SQLite's DROP COLUMN performs —
        // not just `name` — to catch any future migration that corrupts it.
        let (name, color, created_at, updated_at, sort_order): (String, String, i64, i64, i64) =
            conn.query_row(
                "SELECT name, color, created_at, updated_at, sort_order FROM journals WHERE id = 'j1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(name, "J", "existing journal row should survive the drop");
        assert_eq!(color, "#fff", "color must survive the drop");
        assert_eq!(created_at, 0, "created_at must survive the drop");
        assert_eq!(updated_at, 0, "updated_at must survive the drop");
        assert_eq!(sort_order, 0, "sort_order must survive the drop");
    }

    #[test]
    fn migrate_drops_smart_summaries_flag() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Simulate an older install that had the obsolete flag set.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_smart_summaries_enabled', 'true')",
            [],
        )
        .unwrap();
        // Also stash a sibling flag that MUST survive.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_title_suggestions_enabled', 'true')",
            [],
        )
        .unwrap();
        // Re-run migrations — the cleanup should fire and drop only the
        // deprecated key.
        migrate(&conn).unwrap();
        let smart: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_smart_summaries_enabled'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert!(smart.is_none(), "smart_summaries flag should be deleted");
        let title: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_title_suggestions_enabled'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert_eq!(
            title.as_deref(),
            Some("true"),
            "unrelated flags must survive the migration"
        );
    }

    #[test]
    fn migrate_drops_emotion_intensity_and_wipes_emotion() {
        // Simulate a pre-refactor dev DB: create the entries table with the old
        // `emotion_intensity` column and a row that carries an 8-emoji tag.
        // Run migrate() and verify (a) the column is gone, (b) the emotion
        // value is wiped to NULL, (c) the gate flag is set so a second
        // migrate() call does not re-wipe new tags the user added.
        let conn = Connection::open_in_memory().unwrap();
        // Pre-refactor entries shape, plus a legacy 1-column entries_fts so
        // migrate()'s drift-repair tears the FTS table down BEFORE the
        // emotion-wipe UPDATE fires. Otherwise the rebuilt triggers would
        // try to `delete` a rowid the FTS index has never seen → SQLite
        // raises "database disk image is malformed".
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE journals (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                color TEXT, icon TEXT, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, sort_order INTEGER DEFAULT 0);
             CREATE TABLE entries (
                id TEXT PRIMARY KEY,
                journal_id TEXT NOT NULL,
                title TEXT,
                content_text TEXT,
                entry_date INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_deleted INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0,
                emotion TEXT,
                emotion_intensity INTEGER
             );
             CREATE VIRTUAL TABLE entries_fts USING fts5(
                content_text,
                content='entries',
                content_rowid='rowid'
             );
             INSERT INTO journals (id, name, created_at, updated_at)
                VALUES ('j1', 'J', 0, 0);
             INSERT INTO entries (id, journal_id, title, content_text,
                entry_date, created_at, updated_at, emotion, emotion_intensity)
                VALUES ('e1', 'j1', 't', 'b', 0, 0, 0, '😊', 4);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        // Column gone.
        let has_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'emotion_intensity'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_col, 0, "emotion_intensity column should be dropped");

        // Existing emotion wiped.
        let still_set: Option<String> = conn
            .query_row("SELECT emotion FROM entries WHERE id = 'e1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(still_set.is_none(), "legacy emotion value should be NULL");

        // Gate flag set.
        let gate: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'emotions_v2_3_state_migrated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gate, "true");

        // Idempotency: a second migrate() is a no-op for emotions because
        // the column probe returns 0 once the column has been dropped.
        // Verifying via "still NULL" since synthesizing a fresh `UPDATE
        // entries` against the rebuilt FTS5 trigger requires a fully-populated
        // entries row that aligns with the FTS rowids — out of scope here.
        migrate(&conn).unwrap();
        let still_null: Option<String> = conn
            .query_row("SELECT emotion FROM entries WHERE id = 'e1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(still_null.is_none(), "second migrate must remain a no-op");
    }

    #[test]
    fn default_journal_created() {
        let conn = setup();
        let (count, is_initial_placeholder): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(is_initial_placeholder) FROM journals",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(count >= 1, "expected at least one default journal");
        assert_eq!(
            is_initial_placeholder, 1,
            "the seeded default journal must be identifiable during onboarding"
        );
    }

    #[test]
    fn all_tables_exist() {
        let conn = setup();
        let expected = [
            "journals",
            "entries",
            "tags",
            "entry_tags",
            "media",
            "location_aliases",
            "templates",
            "streak_cache",
            "settings",
            "reminders",
            "sync_state",
            "sync_push_state",
            "sync_pull_state",
            "chat_sessions",
            "chat_messages",
            "ai_audit_log",
            "google_fonts_catalog",
            "google_fonts_catalog_meta",
            // Phase N keyring V2 tables
            "devices",
            "rotation_job",
            "rotation_job_items",
            "pending_first_time_setup",
            "sync_recovery_jobs",
            // AI User Memory (2026-07-29)
            "memory_items",
            "memory_item_sources",
            "memory_embeddings",
            "memory_jobs",
            // Invisible Lock multi-vault (2026-08-12)
            "invisible_vaults",
        ];
        for table in &expected {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assert_eq!(exists, 1, "table '{}' should exist", table);
        }
    }

    #[test]
    fn migrate_adds_second_lock_columns_to_fresh_db() {
        let conn = setup();

        for table in ["entries", "journals"] {
            let has_is_locked: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'is_locked'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                has_is_locked, 1,
                "{table}.is_locked should exist after migrate()"
            );
            let has_is_invisible: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'is_invisible'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                has_is_invisible, 1,
                "{table}.is_invisible should exist after migrate()"
            );
        }

        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let journal_locked: i64 = conn
            .query_row(
                "SELECT is_locked FROM journals WHERE id = ?1",
                [&journal_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(journal_locked, 0, "journals default to unlocked");
        let journal_invisible: i64 = conn
            .query_row(
                "SELECT is_invisible FROM journals WHERE id = ?1",
                [&journal_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(journal_invisible, 0, "journals default to visible");

        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
             VALUES ('entry-second-lock-default', ?1, 1, 1, 1)",
            [&journal_id],
        )
        .unwrap();
        let entry_locked: i64 = conn
            .query_row(
                "SELECT is_locked FROM entries WHERE id = 'entry-second-lock-default'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(entry_locked, 0, "entries default to unlocked");
        let entry_invisible: i64 = conn
            .query_row(
                "SELECT is_invisible FROM entries WHERE id = 'entry-second-lock-default'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(entry_invisible, 0, "entries default to visible");
    }

    #[test]
    fn migrate_backfills_second_lock_columns_on_existing_dev_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE journals (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                color TEXT,
                icon TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0
            );
            CREATE TABLE entries (
                id TEXT PRIMARY KEY NOT NULL,
                journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
                title TEXT,
                preview_text TEXT,
                content_text TEXT,
                entry_date INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_favorite INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0
            );
            CREATE VIRTUAL TABLE entries_fts USING fts5(
                title,
                content_text,
                content='entries',
                content_rowid='rowid'
            );
            INSERT INTO journals (id, name, created_at, updated_at)
                VALUES ('legacy-journal', 'Legacy', 1, 1);
            INSERT INTO entries (id, journal_id, title, content_text, entry_date, created_at, updated_at)
                VALUES ('legacy-entry', 'legacy-journal', 'Legacy title', 'Legacy body', 1, 1, 1);
            INSERT INTO entries_fts(rowid, title, content_text)
                SELECT rowid, title, content_text FROM entries WHERE id = 'legacy-entry';
            ",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let journal_locked: i64 = conn
            .query_row(
                "SELECT is_locked FROM journals WHERE id = 'legacy-journal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let entry_locked: i64 = conn
            .query_row(
                "SELECT is_locked FROM entries WHERE id = 'legacy-entry'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(journal_locked, 0, "existing journals backfill unlocked");
        assert_eq!(entry_locked, 0, "existing entries backfill unlocked");
        let journal_invisible: i64 = conn
            .query_row(
                "SELECT is_invisible FROM journals WHERE id = 'legacy-journal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let entry_invisible: i64 = conn
            .query_row(
                "SELECT is_invisible FROM entries WHERE id = 'legacy-entry'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(journal_invisible, 0, "existing journals backfill visible");
        assert_eq!(entry_invisible, 0, "existing entries backfill visible");
    }

    #[test]
    fn migrate_creates_invisible_vaults_and_vault_id_columns() {
        let conn = setup();

        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='invisible_vaults'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 1, "invisible_vaults table must exist");

        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('invisible_vaults')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for col in ["id", "verifier", "created_at", "updated_at"] {
            assert!(
                cols.contains(&col.to_string()),
                "invisible_vaults must have column '{col}'"
            );
        }

        for table in ["entries", "journals"] {
            let has_vault_id: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'vault_id'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                has_vault_id, 1,
                "{table}.vault_id should exist after migrate()"
            );
            let has_is_invisible: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'is_invisible'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                has_is_invisible, 1,
                "{table}.is_invisible must remain after multi-vault schema"
            );
        }

        // Fresh rows default vault_id to NULL; is_invisible stays 0.
        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let journal_vault: Option<String> = conn
            .query_row(
                "SELECT vault_id FROM journals WHERE id = ?1",
                [&journal_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            journal_vault.is_none(),
            "journals.vault_id defaults to NULL"
        );
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at)
             VALUES ('entry-vault-default', ?1, 1, 1, 1)",
            [&journal_id],
        )
        .unwrap();
        let entry_vault: Option<String> = conn
            .query_row(
                "SELECT vault_id FROM entries WHERE id = 'entry-vault-default'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(entry_vault.is_none(), "entries.vault_id defaults to NULL");

        // Insert + read a vault row to confirm table shape is usable.
        conn.execute(
            "INSERT INTO invisible_vaults (id, verifier, created_at, updated_at)
             VALUES ('vault-1', '$argon2id$test', 1, 1)",
            [],
        )
        .unwrap();
        let verifier: String = conn
            .query_row(
                "SELECT verifier FROM invisible_vaults WHERE id = 'vault-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(verifier, "$argon2id$test");
    }

    #[test]
    fn migrate_backfills_vault_id_columns_on_existing_dev_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE journals (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                color TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0,
                is_locked INTEGER DEFAULT 0,
                is_invisible INTEGER DEFAULT 0
            );
            CREATE TABLE entries (
                id TEXT PRIMARY KEY NOT NULL,
                journal_id TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
                title TEXT,
                preview_text TEXT,
                content_text TEXT,
                entry_date INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_favorite INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0,
                is_locked INTEGER DEFAULT 0,
                is_invisible INTEGER DEFAULT 0
            );
            CREATE VIRTUAL TABLE entries_fts USING fts5(
                title,
                content_text,
                content='entries',
                content_rowid='rowid'
            );
            INSERT INTO journals (id, name, created_at, updated_at, is_invisible)
                VALUES ('legacy-j-vault', 'Legacy', 1, 1, 1);
            INSERT INTO entries (id, journal_id, title, content_text, entry_date,
                                 created_at, updated_at, is_invisible)
                VALUES ('legacy-e-vault', 'legacy-j-vault', 'T', 'B', 1, 1, 1, 1);
            INSERT INTO entries_fts(rowid, title, content_text)
                SELECT rowid, title, content_text FROM entries WHERE id = 'legacy-e-vault';
            ",
        )
        .unwrap();

        migrate(&conn).unwrap();

        // vault_id columns exist and stay NULL (hard cut — no verifier→vault migration).
        let j_vault: Option<String> = conn
            .query_row(
                "SELECT vault_id FROM journals WHERE id = 'legacy-j-vault'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let e_vault: Option<String> = conn
            .query_row(
                "SELECT vault_id FROM entries WHERE id = 'legacy-e-vault'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(j_vault.is_none(), "legacy journals keep vault_id NULL");
        assert!(e_vault.is_none(), "legacy entries keep vault_id NULL");

        // is_invisible flag is preserved (not wiped by multi-vault schema).
        let j_inv: i64 = conn
            .query_row(
                "SELECT is_invisible FROM journals WHERE id = 'legacy-j-vault'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let e_inv: i64 = conn
            .query_row(
                "SELECT is_invisible FROM entries WHERE id = 'legacy-e-vault'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(j_inv, 1);
        assert_eq!(e_inv, 1);

        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='invisible_vaults'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 1);
    }

    #[test]
    fn migrate_preserves_invisible_lock_verifier_and_does_not_create_vaults() {
        // Phase 1–2 still own the settings verifier via legacy commands.
        // migrate() must not wipe it on every launch (would strand is_invisible).
        let conn = setup();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value)
             VALUES ('invisible_lock_verifier', '$argon2id$legacy')",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(
            get_setting_raw(&conn, "invisible_lock_verifier").as_deref(),
            Some("$argon2id$legacy"),
            "migrate must preserve invisible_lock_verifier until Phase 3 drops the path"
        );
        let vault_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM invisible_vaults", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            vault_count, 0,
            "must not migrate settings verifier into invisible_vaults"
        );
    }

    #[test]
    fn fts5_virtual_table_exists() {
        let conn = setup();
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        assert_eq!(exists, 1, "FTS5 virtual table entries_fts should exist");
    }

    #[test]
    fn fts5_has_two_indexed_columns() {
        let conn = setup();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entries_fts')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 2,
            "FTS5 target is exactly two indexed columns (title_fold, content_fold)"
        );
    }

    #[test]
    fn keyring_v2_tables_exist_after_migrate() {
        let conn = setup();
        let new_tables = [
            "devices",
            "rotation_job",
            "rotation_job_items",
            "pending_first_time_setup",
        ];
        for table in &new_tables {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assert_eq!(exists, 1, "keyring V2 table '{}' must exist", table);
        }
        // idx_rotation_job_items_status index must exist.
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_rotation_job_items_status'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        assert_eq!(idx, 1, "idx_rotation_job_items_status must exist");
    }

    #[test]
    fn keyring_v2_tables_idempotent_on_second_migrate() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Second migrate must not fail — all DDL uses IF NOT EXISTS.
        migrate(&conn).unwrap();
        // Tables must still exist.
        for table in [
            "devices",
            "rotation_job",
            "rotation_job_items",
            "pending_first_time_setup",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assert_eq!(exists, 1, "table '{}' must survive double migrate", table);
        }
    }

    #[test]
    fn sync_recovery_job_checks_reject_invalid_values() {
        let conn = setup();
        let invalid_operation = conn.execute(
            "INSERT INTO sync_recovery_jobs
             (operation, phase, status, recovery_generation, created_at, updated_at)
             VALUES ('invalid', 'created', 'pending', 1, 1, 1)",
            [],
        );
        let invalid_phase = conn.execute(
            "INSERT INTO sync_recovery_jobs
             (operation, phase, status, recovery_generation, created_at, updated_at)
             VALUES ('local_to_cloud', 'invalid', 'pending', 1, 1, 1)",
            [],
        );
        let invalid_status = conn.execute(
            "INSERT INTO sync_recovery_jobs
             (operation, phase, status, recovery_generation, created_at, updated_at)
             VALUES ('local_to_cloud', 'created', 'invalid', 1, 1, 1)",
            [],
        );
        let invalid_generation = conn.execute(
            "INSERT INTO sync_recovery_jobs
             (operation, phase, status, recovery_generation, created_at, updated_at)
             VALUES ('local_to_cloud', 'created', 'pending', 0, 1, 1)",
            [],
        );

        assert!(
            invalid_operation.is_err()
                && invalid_phase.is_err()
                && invalid_status.is_err()
                && invalid_generation.is_err(),
            "recovery job CHECK constraints must reject unknown states and zero generation"
        );
    }

    #[test]
    fn keyring_v2_check_constraints_gate_preserves_data_across_migrate() {
        // The DROP-then-CHECK-recreate block is gated by the
        // `keyring_v2_check_constraints_applied_v2` settings flag. Without the
        // gate, every migrate() would wipe Phase 2+ data. This test inserts
        // a row, re-runs migrate(), and verifies the row survives.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO devices (device_id, name, created_at, last_seen_at, is_current, is_revoked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["abc12345", "TestDevice", 1_700_000_000i64, 1_700_000_000i64, 1, 0],
        )
        .unwrap();

        // Re-run migrate. The gate must prevent the DROP/recreate block from
        // wiping the row.
        migrate(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "device row must survive a second migrate (gate must work)"
        );

        // The gate flag must be set to 'true'.
        let flag: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'keyring_v2_check_constraints_applied_v2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, "true");
    }

    // ── CHECK constraint tests for Phase 1 keyring tables ───────────────────

    fn keyring_setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn rotation_job_state_check_rejects_invalid() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let bad = conn.execute(
            "INSERT INTO rotation_job
             (state, old_fingerprint, new_fingerprint, old_epoch, new_epoch, started_at, updated_at)
             VALUES ('foo', 'fp1', 'fp2', 1, 2, ?1, ?1)",
            rusqlite::params![now],
        );
        assert!(
            bad.is_err(),
            "state='foo' must be rejected by CHECK constraint"
        );
    }

    #[test]
    fn rotation_job_state_check_accepts_valid() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        for state in &[
            "enumerate",
            "reencrypt",
            "commit_local",
            "enumerate_stragglers",
            "publish_keyring",
            "done",
            "aborted",
        ] {
            let result = conn.execute(
                "INSERT INTO rotation_job
                 (state, old_fingerprint, new_fingerprint, old_epoch, new_epoch, started_at, updated_at)
                 VALUES (?1, 'fp1', 'fp2', 1, 2, ?2, ?2)",
                rusqlite::params![state, now],
            );
            assert!(result.is_ok(), "state='{state}' should be accepted");
        }
    }

    #[test]
    fn rotation_job_state_check_accepts_enumerate_stragglers() {
        // Phase 5 sub-step: after commit_local the publisher re-enumerates
        // files modified since started_at and re-encrypts stragglers.
        // This state must be persisted in the rotation_job table.
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let result = conn.execute(
            "INSERT INTO rotation_job
             (state, old_fingerprint, new_fingerprint, old_epoch, new_epoch, started_at, updated_at)
             VALUES ('enumerate_stragglers', 'fp1', 'fp2', 1, 2, ?1, ?1)",
            rusqlite::params![now],
        );
        assert!(
            result.is_ok(),
            "state='enumerate_stragglers' must be accepted by CHECK constraint"
        );
    }

    #[test]
    fn rotation_job_items_envelope_kind_check_rejects_invalid() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let job_id: i64 = conn
            .query_row(
                "INSERT INTO rotation_job
                 (state, old_fingerprint, new_fingerprint, old_epoch, new_epoch, started_at, updated_at)
                 VALUES ('enumerate', 'fp1', 'fp2', 1, 2, ?1, ?1)
                 RETURNING id",
                rusqlite::params![now],
                |r| r.get(0),
            )
            .unwrap();
        let bad = conn.execute(
            "INSERT INTO rotation_job_items (rotation_id, envelope_kind, envelope_id)
             VALUES (?1, 'bogus', 'path/to/item')",
            rusqlite::params![job_id],
        );
        assert!(bad.is_err(), "envelope_kind='bogus' must be rejected");
    }

    #[test]
    fn rotation_job_items_status_check_rejects_invalid() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let job_id: i64 = conn
            .query_row(
                "INSERT INTO rotation_job
                 (state, old_fingerprint, new_fingerprint, old_epoch, new_epoch, started_at, updated_at)
                 VALUES ('enumerate', 'fp1', 'fp2', 1, 2, ?1, ?1)
                 RETURNING id",
                rusqlite::params![now],
                |r| r.get(0),
            )
            .unwrap();
        let bad = conn.execute(
            "INSERT INTO rotation_job_items (rotation_id, envelope_kind, envelope_id, status)
             VALUES (?1, 'entry', 'path/to/item', 'sent')",
            rusqlite::params![job_id],
        );
        assert!(
            bad.is_err(),
            "status='sent' must be rejected by CHECK constraint"
        );
    }

    #[test]
    fn devices_is_current_check_rejects_value_two() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let bad = conn.execute(
            "INSERT INTO devices (device_id, name, created_at, last_seen_at, is_current, is_revoked)
             VALUES ('dev-001', 'Test', ?1, ?1, 2, 0)",
            rusqlite::params![now],
        );
        assert!(
            bad.is_err(),
            "is_current=2 must be rejected by CHECK constraint"
        );
    }

    #[test]
    fn devices_is_revoked_check_rejects_negative() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let bad = conn.execute(
            "INSERT INTO devices (device_id, name, created_at, last_seen_at, is_current, is_revoked)
             VALUES ('dev-002', 'Test', ?1, ?1, 0, -1)",
            rusqlite::params![now],
        );
        assert!(
            bad.is_err(),
            "is_revoked=-1 must be rejected by CHECK constraint"
        );
    }

    #[test]
    fn devices_check_accepts_valid_row() {
        let conn = keyring_setup();
        let now = 1_700_000_000i64;
        let result = conn.execute(
            "INSERT INTO devices (device_id, name, created_at, last_seen_at, is_current, is_revoked)
             VALUES ('dev-valid', 'My Device', ?1, ?1, 1, 0)",
            rusqlite::params![now],
        );
        assert!(result.is_ok(), "valid devices row must be accepted");
    }

    #[test]
    fn migrate_wipes_legacy_ai_provider_keys_and_partitions_correctly() {
        // R11 split — the legacy single-provider settings rows must be
        // dropped on migration so the app boots with both gen + embed
        // slots unconfigured. Feature toggles, daily-chat prefs,
        // `ai_v2_migrated`, and any pre-existing new split keys MUST
        // survive. A single seed-all-then-migrate test exercises the
        // full partition (wipe + preserve + new-split-untouched) so a
        // future regression in the delete loop can't pass by satisfying
        // only one half.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Force a re-run by clearing the gate (the first migrate above
        // already set it because the in-memory DB started empty).
        conn.execute(
            "DELETE FROM settings WHERE key = 'ai_v11_provider_split_migrated'",
            [],
        )
        .unwrap();
        let legacy = [
            ("ai_provider", "openai"),
            ("ai_endpoint", "https://api.openai.com/v1"),
            ("ai_endpoint_class", "remote"),
            ("ai_api_key", "sk-test"),
            ("ai_chat_model", "gpt-4o-mini"),
            ("ai_embedding_model", "text-embedding-3-small"),
            ("ai_image_model", "dall-e-3"),
            ("ai_privacy_accepted_at", "1234567890"),
        ];
        let preserved = [
            ("ai_semantic_search_enabled", "true"),
            ("ai_emotion_suggestions_enabled", "true"),
            ("ai_daily_chat_persona", "empathetic"),
            ("ai_emotion_suggestion_language", "vi"),
            // The earlier-generation flag MUST survive — losing it
            // would re-trigger the R3 orphan-row cleanup.
            ("ai_v2_migrated", "true"),
        ];
        let new_split = [
            ("ai_gen_provider", "anthropic"),
            ("ai_gen_endpoint", "https://api.anthropic.com/v1"),
            ("ai_embed_provider", "openai"),
            ("ai_embed_embedding_model", "text-embedding-3-small"),
        ];
        for (k, v) in legacy
            .iter()
            .chain(preserved.iter())
            .chain(new_split.iter())
        {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![k, v],
            )
            .unwrap();
        }
        // Run migration (gate cleared above so R11 step fires).
        migrate(&conn).unwrap();
        for (k, _) in legacy.iter() {
            let row: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [k], |r| {
                    r.get(0)
                })
                .ok();
            assert!(row.is_none(), "legacy key {k} should be wiped by R11");
        }
        for (k, v) in preserved.iter().chain(new_split.iter()) {
            let row: String = conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [k], |r| {
                    r.get(0)
                })
                .unwrap_or_else(|e| panic!("non-legacy key {k} lost: {e}"));
            assert_eq!(&row, v, "non-legacy key {k} value should match");
        }
        // Gate flag now set.
        let gate: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_v11_provider_split_migrated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gate, "true");
    }

    #[test]
    fn migrate_r11_gate_prevents_second_wipe() {
        // Defuses the wipe-on-every-launch loop: once the gate flag is
        // set, a user who re-enters their (legacy-shape) config does
        // NOT lose it on the next launch. Step 3 will retire the
        // legacy keys entirely — this test guards the intermediate
        // state where step 2 ships before step 3.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Gate is set by the first migrate.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_provider', 'openai')",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        let row: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_provider'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            row, "openai",
            "post-gate re-launch must NOT re-wipe legacy keys"
        );
    }

    #[test]
    fn migrate_wipes_dead_credential_registry_keys() {
        // R12 — the 12 dead per-slot endpoint/endpoint_class/api_key rows
        // plus the 2 dead legacy-keyring rows must be dropped on
        // migration in favour of the per-preset `ai_provider_endpoints` /
        // `ai_provider_keyring` registry.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Force a re-run by clearing the gate (the first migrate above
        // already set it because the in-memory DB started empty).
        conn.execute(
            "DELETE FROM settings WHERE key = 'ai_v12_credential_registry_migrated'",
            [],
        )
        .unwrap();
        let dead = [
            ("ai_gen_endpoint", "https://api.openai.com/v1"),
            ("ai_gen_endpoint_class", "remote"),
            ("ai_gen_api_key", "sk-test-gen"),
            ("ai_embed_endpoint", "https://api.openai.com/v1"),
            ("ai_embed_endpoint_class", "remote"),
            ("ai_embed_api_key", "sk-test-embed"),
            ("ai_memory_gen_endpoint", "https://api.openai.com/v1"),
            ("ai_memory_gen_endpoint_class", "remote"),
            ("ai_memory_gen_api_key", "sk-test-memory-gen"),
            ("ai_memory_embed_endpoint", "https://api.openai.com/v1"),
            ("ai_memory_embed_endpoint_class", "remote"),
            ("ai_memory_embed_api_key", "sk-test-memory-embed"),
            ("ai_gen_api_keyring", "{\"openai\":\"sk-legacy\"}"),
            ("ai_gen_api_key_legacy_quarantined", "true"),
        ];
        for (k, v) in dead.iter() {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![k, v],
            )
            .unwrap();
        }
        // Run migration (gate cleared above so R12 step fires).
        migrate(&conn).unwrap();
        for (k, _) in dead.iter() {
            let row: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [k], |r| {
                    r.get(0)
                })
                .ok();
            assert!(
                row.is_none(),
                "dead credential-registry key {k} should be wiped by R12"
            );
        }
        // Gate flag now set.
        let gate: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_v12_credential_registry_migrated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gate, "true");
    }

    #[test]
    fn migrate_r12_gate_prevents_second_wipe() {
        // Defuses the wipe-on-every-launch loop: once the gate flag is
        // set, a user who re-adds one of the dead credential-registry
        // keys (e.g. a stray sync payload, or manual DB poking) does NOT
        // lose it on the next launch. This is the exact failure the R11
        // gate comment warns about, mirrored for R12.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Gate is set by the first migrate.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_gen_endpoint', 're-added')",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        let row: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_gen_endpoint'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            row, "re-added",
            "post-gate re-launch must NOT re-wipe dead credential-registry keys"
        );
    }

    #[test]
    fn sync_state_table_shape() {
        // The sync_state table should have: entry_id PK, local_version,
        // synced_version, last_synced_at, sync_status.
        let conn = setup();
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('sync_state')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(cols.contains(&"entry_id".to_string()));
        assert!(cols.contains(&"local_version".to_string()));
        assert!(cols.contains(&"synced_version".to_string()));
        assert!(cols.contains(&"last_synced_at".to_string()));
        assert!(cols.contains(&"sync_status".to_string()));
    }

    #[test]
    fn sync_state_migration_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert!(migrate(&conn).is_ok());
        // Inserting a duplicate entry_id should fail (PK constraint).
        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at) \
             VALUES ('e1', ?1, ?2, ?2, ?2)",
            rusqlite::params![journal_id, now],
        )
        .unwrap();
        conn.execute("INSERT INTO sync_state (entry_id) VALUES ('e1')", [])
            .unwrap();
        let dup = conn.execute("INSERT INTO sync_state (entry_id) VALUES ('e1')", []);
        assert!(dup.is_err(), "duplicate entry_id should violate PK");
    }

    #[test]
    fn sync_state_fk_cascades_on_entry_delete() {
        let conn = setup();
        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at) \
             VALUES ('e_cascade', ?1, ?2, ?2, ?2)",
            rusqlite::params![journal_id, now],
        )
        .unwrap();
        conn.execute("INSERT INTO sync_state (entry_id) VALUES ('e_cascade')", [])
            .unwrap();

        // Hard-delete the entry — sync_state row must cascade.
        conn.execute("DELETE FROM entries WHERE id = 'e_cascade'", [])
            .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_state WHERE entry_id = 'e_cascade'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "sync_state row should cascade-delete");
    }

    #[test]
    fn sync_state_status_check_constraint() {
        let conn = setup();
        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO entries (id, journal_id, entry_date, created_at, updated_at) \
             VALUES ('e_chk', ?1, ?2, ?2, ?2)",
            rusqlite::params![journal_id, now],
        )
        .unwrap();
        // Invalid sync_status must be rejected by CHECK constraint.
        let bad = conn.execute(
            "INSERT INTO sync_state (entry_id, sync_status) VALUES ('e_chk', 'bogus')",
            [],
        );
        assert!(bad.is_err(), "bogus sync_status should violate CHECK");
    }

    #[test]
    fn fts5_drift_is_repaired_on_migrate() {
        // Simulate a pre-Phase-2 DB: create entries_fts with one indexed
        // column (`content_text` only) and old triggers, then call migrate()
        // and verify the shape is upgraded to two columns.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE entries (
                id TEXT PRIMARY KEY NOT NULL,
                journal_id TEXT NOT NULL,
                title TEXT,
                content_text TEXT,
                preview_text TEXT,
                entry_date INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_deleted INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0
            );
            CREATE VIRTUAL TABLE entries_fts USING fts5(
                content_text,
                content='entries',
                content_rowid='rowid'
            );
            ",
        )
        .unwrap();

        // Pre-condition: 1 FTS column (old shape).
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entries_fts')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 1, "simulated legacy DB should have 1 FTS column");

        // Run migration — guard should rebuild the table to the new two-column shape.
        migrate(&conn).unwrap();

        let after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('entries_fts')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            after, 2,
            "migrate() must rebuild entries_fts to a two-column shape (title_fold, content_fold)"
        );
    }

    #[test]
    fn fresh_db_is_not_flagged_as_fts_drift() {
        // Guards the every-launch cost path: a freshly-migrated DB must NOT look
        // drifted, or `migrate()` would drop + `'rebuild'` the whole FTS index
        // on every app start. This catches any mismatch between the tokenizer
        // literal we write and the text SQLite stores in `sqlite_master.sql`.
        let conn = setup();
        assert!(
            !drop_fts_if_drifted(&conn).unwrap(),
            "a current DB must not be flagged as FTS drift"
        );
        // And the table it just inspected is still standing.
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            exists, 1,
            "drift check must not tear down a current FTS table"
        );
    }

    #[test]
    fn migrate_reindexes_existing_rows_accent_insensitively() {
        // Simulate an existing dev DB built BEFORE accent-insensitive search:
        // a 2-column entries_fts on the default tokenizer, `entries` without the
        // fold columns, and a pre-existing row with Vietnamese diacritics + `đ`.
        // migrate() must (a) backfill the fold columns, (b) detect the old
        // tokenizer and rebuild the FTS, and (c) leave the existing row
        // searchable with an unaccented query — the path that protects existing
        // users' data.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE journals (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE entries (
                id TEXT PRIMARY KEY NOT NULL,
                journal_id TEXT NOT NULL,
                title TEXT,
                preview_text TEXT,
                content_text TEXT,
                entry_date INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_deleted INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0
            );
            CREATE VIRTUAL TABLE entries_fts USING fts5(
                title,
                content_text,
                content='entries',
                content_rowid='rowid'
            );
            INSERT INTO journals (id, name, created_at, updated_at)
                VALUES ('j1', 'J', 0, 0);
            INSERT INTO entries (id, journal_id, title, content_text,
                entry_date, created_at, updated_at)
                VALUES ('old', 'j1', 'Con đường phố', 'Một thử thách được vượt qua', 1, 1, 1);
            INSERT INTO entries_fts(rowid, title, content_text)
                SELECT rowid, title, content_text FROM entries WHERE id = 'old';
            ",
        )
        .unwrap();

        // Pre-condition: default tokenizer can't fold — unaccented query misses.
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH '\"thu\" \"thach\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 0, "old tokenizer must not fold diacritics");

        migrate(&conn).unwrap();

        // Fold columns backfilled onto the pre-existing table.
        let has_fold: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_xinfo('entries') WHERE name = 'content_fold'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_fold, 1, "migrate() must backfill the fold columns");

        // The pre-existing row is now searchable accent-insensitively, including
        // the đ-word (title) — proving the rebuild reindexed old rows.
        let thu: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH '\"thu\" \"thach\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(thu, 1, "'thu thach' must match the reindexed 'thử thách'");
        let duong: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'duong'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            duong, 1,
            "'duong' must match the reindexed 'đường' (đ-fold)"
        );
    }

    #[test]
    fn migrate_creates_chat_tables() {
        let conn = setup();

        // Tables exist
        for table in ["chat_sessions", "chat_messages"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "table '{}' should exist", table);
        }

        // Indices exist
        for idx in ["idx_chat_messages_session_seq", "idx_chat_sessions_updated"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "index '{}' should exist", idx);
        }

        // FK CASCADE: deleting a session must drop its messages.
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO chat_sessions (id, persona, persona_prompt_snapshot, language, created_at, updated_at) \
             VALUES ('s1', 'empathetic', 'be kind', 'auto', ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, seq, created_at) \
             VALUES ('m1', 's1', 'user', 'hi', 0, ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        conn.execute("DELETE FROM chat_sessions WHERE id='s1'", [])
            .unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "messages should cascade-delete with session");

        // CHECK constraint on role
        conn.execute(
            "INSERT INTO chat_sessions (id, persona, persona_prompt_snapshot, language, created_at, updated_at) \
             VALUES ('s2', 'empathetic', 'p', 'auto', ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        let bad = conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, seq, created_at) \
             VALUES ('mbad', 's2', 'system', 'x', 0, ?1)",
            rusqlite::params![now],
        );
        assert!(bad.is_err(), "role must be one of ('user','assistant')");
    }

    #[test]
    fn pagination_indexes_on_entries_exist() {
        let conn = setup();
        let expected_entry_indexes = [
            "idx_entries_entry_date_desc",
            "idx_entries_journal_entry_date",
            "idx_entries_favorite_entry_date",
            "idx_entries_updated_at",
        ];
        let actual: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_list('entries')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for name in &expected_entry_indexes {
            assert!(
                actual.contains(&name.to_string()),
                "index '{}' must exist on entries",
                name
            );
        }
    }

    #[test]
    fn pagination_index_on_media_exists() {
        let conn = setup();
        let actual: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_list('media')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            actual.contains(&"idx_media_created_at".to_string()),
            "index 'idx_media_created_at' must exist on media; found: {:?}",
            actual
        );
    }

    #[test]
    fn fts_indexes_both_title_and_content_after_insert_update_delete() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let now = 1_700_000_000i64;

        // INSERT: both title and content_text must be searchable.
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date, created_at, updated_at) \
             VALUES ('e1', ?1, 'alpha bravo', 'beta gamma', ?2, ?2, ?2)",
            rusqlite::params![journal_id, now],
        )
        .unwrap();

        let hit_alpha: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hit_alpha, 1, "'alpha' (title word) must match after insert");

        let hit_beta: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'beta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hit_beta, 1, "'beta' (content word) must match after insert");

        // UPDATE: old title tokens gone, new title tokens indexed.
        conn.execute(
            "UPDATE entries SET title = 'charlie', updated_at = ?1 WHERE id = 'e1'",
            rusqlite::params![now + 1],
        )
        .unwrap();

        let hit_alpha_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'alpha'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            hit_alpha_after, 0,
            "'alpha' must not match after title update"
        );

        let hit_charlie: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'charlie'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            hit_charlie, 1,
            "'charlie' (new title) must match after update"
        );

        // DELETE: no tokens should remain.
        conn.execute("DELETE FROM entries WHERE id = 'e1'", [])
            .unwrap();

        let hit_beta_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'beta'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hit_beta_after, 0, "'beta' must not match after delete");
    }

    // ── encryption_enabled cleanup tests ────────────────────────────────────

    fn get_setting_raw(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok()
    }

    #[test]
    fn migration_deletes_legacy_encryption_enabled_row() {
        // Simulate a pre-Phase-2 DB that still has the old encryption_enabled row.
        let conn = Connection::open_in_memory().unwrap();
        // Manually insert the legacy row before running migrate.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('encryption_enabled', 'true')",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        // After migration the legacy key must be gone.
        assert!(
            get_setting_raw(&conn, "encryption_enabled").is_none(),
            "migration must delete the legacy encryption_enabled row"
        );
    }

    #[test]
    fn migration_deletes_encryption_mode_v1_migrated_sentinel() {
        // The v1-migration sentinel from Phase 1 must also be cleaned up.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('encryption_mode_v1_migrated', 'true')",
            [],
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert!(
            get_setting_raw(&conn, "encryption_mode_v1_migrated").is_none(),
            "migration must delete the encryption_mode_v1_migrated sentinel"
        );
    }

    #[test]
    fn migration_cleanup_is_idempotent_when_rows_absent() {
        // Running migrate on a DB that never had the legacy keys must not error.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // No row → DELETE is a no-op; running again must also not error.
        migrate(&conn).unwrap();
        assert!(get_setting_raw(&conn, "encryption_enabled").is_none());
        assert!(get_setting_raw(&conn, "encryption_mode_v1_migrated").is_none());
    }

    // ── Embedding Cost Guardrails Phase 1 Task 1 ───────────────────────────

    #[test]
    fn embedding_migration_creates_chunk_table_with_expected_columns() {
        let conn = setup();
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('entry_embedding_chunks')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for col in [
            "entry_id",
            "model_id",
            "chunk_index",
            "content_hash",
            "char_start",
            "char_end",
            "preview",
            "dim",
            "vec",
            "indexed_at",
        ] {
            assert!(
                cols.contains(&col.to_string()),
                "entry_embedding_chunks missing column '{}': {:?}",
                col,
                cols
            );
        }
    }

    #[test]
    fn embedding_migration_creates_jobs_table_with_expected_columns() {
        let conn = setup();
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('entry_embedding_jobs')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for col in [
            "entry_id",
            "model_id",
            "content_hash",
            "status",
            "dirty_at",
            "next_attempt_at",
            "last_attempt_at",
            "attempt_count",
            "last_error",
            "updated_at",
        ] {
            assert!(
                cols.contains(&col.to_string()),
                "entry_embedding_jobs missing column '{}': {:?}",
                col,
                cols
            );
        }
    }

    #[test]
    fn embedding_migration_creates_expected_indexes() {
        let conn = setup();
        let chunk_indexes: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_list('entry_embedding_chunks')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for idx in [
            "idx_entry_embedding_chunks_model",
            "idx_entry_embedding_chunks_entry_model",
        ] {
            assert!(
                chunk_indexes.contains(&idx.to_string()),
                "index '{}' must exist on entry_embedding_chunks; found: {:?}",
                idx,
                chunk_indexes
            );
        }

        let job_indexes: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_list('entry_embedding_jobs')")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            job_indexes.contains(&"idx_entry_embedding_jobs_model_status_due".to_string()),
            "index 'idx_entry_embedding_jobs_model_status_due' must exist on entry_embedding_jobs; found: {:?}",
            job_indexes
        );
    }

    #[test]
    fn embedding_migration_drops_legacy_entries_embeddings_table() {
        // Simulate a pre-cutover dev DB that still has the old entry-level
        // table (created by a build predating this migration).
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE entries_embeddings (
                entry_id    TEXT NOT NULL,
                model_id    TEXT NOT NULL,
                dim         INTEGER NOT NULL,
                vec         BLOB NOT NULL,
                indexed_at  INTEGER NOT NULL,
                PRIMARY KEY (entry_id, model_id)
            );",
        )
        .unwrap();

        // Re-running migrate() must drop the legacy table.
        migrate(&conn).unwrap();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries_embeddings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 0, "legacy entries_embeddings table must be dropped");
    }

    #[test]
    fn ask_journal_queries_table_is_dropped_by_migrate() {
        // Simulate a dev DB that still has the removed Ask Journal table.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE ask_journal_queries (
                id          TEXT PRIMARY KEY NOT NULL,
                question    TEXT NOT NULL,
                answer      TEXT NOT NULL,
                sources     TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL,
                is_deleted  INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ask_journal_queries'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            exists, 0,
            "ask_journal_queries table must be dropped by migrate()"
        );
    }

    #[test]
    fn embedding_migration_enforces_pk_check_and_cascade() {
        let conn = setup();
        let now = 1_700_000_000i64;
        let journal_id: String = conn
            .query_row("SELECT id FROM journals LIMIT 1", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO entries (id, journal_id, title, content_text, entry_date, created_at, updated_at)
             VALUES ('e1', ?1, 't', 'c', ?2, ?2, ?2)",
            rusqlite::params![journal_id, now],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO entry_embedding_chunks
                (entry_id, model_id, chunk_index, content_hash, char_start, char_end, preview, dim, vec, indexed_at)
             VALUES ('e1', 'm1', 0, 'h1', 0, 5, 'prev', 3, x'000000000000000000000000', ?1)",
            rusqlite::params![now],
        )
        .unwrap();

        // Duplicate (entry_id, model_id, chunk_index) must violate the PK.
        let dup = conn.execute(
            "INSERT INTO entry_embedding_chunks
                (entry_id, model_id, chunk_index, content_hash, char_start, char_end, preview, dim, vec, indexed_at)
             VALUES ('e1', 'm1', 0, 'h2', 0, 5, 'prev2', 3, x'000000000000000000000000', ?1)",
            rusqlite::params![now],
        );
        assert!(
            dup.is_err(),
            "duplicate (entry_id, model_id, chunk_index) must violate the PK"
        );

        conn.execute(
            "INSERT INTO entry_embedding_jobs (entry_id, model_id, content_hash, status, dirty_at, updated_at)
             VALUES ('e1', 'm1', 'h', 'pending', ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();

        // status must be constrained to the known set.
        let bad_status = conn.execute(
            "INSERT INTO entry_embedding_jobs (entry_id, model_id, content_hash, status, dirty_at, updated_at)
             VALUES ('e1', 'm2', 'h', 'bogus', ?1, ?1)",
            rusqlite::params![now],
        );
        assert!(
            bad_status.is_err(),
            "status must be constrained to the known enum values"
        );

        // Hard-deleting the entry must cascade both chunk and job rows.
        conn.execute("DELETE FROM entries WHERE id = 'e1'", [])
            .unwrap();
        let chunk_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entry_embedding_chunks WHERE entry_id = 'e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            chunk_count, 0,
            "chunks must cascade-delete with their entry"
        );
        let job_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entry_embedding_jobs WHERE entry_id = 'e1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(job_count, 0, "jobs must cascade-delete with their entry");
    }

    #[test]
    fn chat_rag_columns_exist_after_migrate() {
        let conn = setup();

        let (notnull, dflt_value): (i64, Option<String>) = conn
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('chat_sessions') WHERE name = 'used_rag'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("chat_sessions.used_rag should exist after migrate()");
        assert_eq!(notnull, 1, "used_rag should be NOT NULL");
        assert_eq!(
            dflt_value.as_deref(),
            Some("0"),
            "used_rag should default to 0"
        );

        for col in ["attachments", "source_entry_ids", "memory_ids"] {
            let notnull: i64 = conn
                .query_row(
                    &format!(
                        "SELECT \"notnull\" FROM pragma_table_info('chat_messages') WHERE name = '{col}'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("chat_messages.{col} should exist after migrate()"));
            assert_eq!(notnull, 0, "chat_messages.{col} should be nullable");
        }
    }

    #[test]
    fn chat_conversion_columns_exist_after_migrate() {
        let conn = setup();

        for col in ["converted_entry_id", "converted_through_seq"] {
            let notnull: i64 = conn
                .query_row(
                    &format!(
                        "SELECT \"notnull\" FROM pragma_table_info('chat_sessions') WHERE name = '{col}'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| panic!("chat_sessions.{col} should exist after migrate()"));
            assert_eq!(notnull, 0, "chat_sessions.{col} should be nullable");
        }

        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_chat_sessions_converted_entry'",
                [],
                |r| r.get(0),
            )
            .expect("idx_chat_sessions_converted_entry lookup should succeed");
        assert_eq!(
            index_count, 1,
            "partial index idx_chat_sessions_converted_entry should exist after migrate()"
        );
    }

    // ── AI User Memory (2026-07-29) ─────────────────────────────────────────

    #[test]
    fn memory_tables_exist_and_migrate_is_idempotent() {
        // The 4 memory tables are created via CREATE TABLE IF NOT EXISTS in
        // the main migrate() batch, so a second migrate() must be a no-op.
        // Mirrors the keyring_v2_tables_idempotent_on_second_migrate posture.
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Second migrate must not fail — all DDL uses IF NOT EXISTS.
        migrate(&conn).unwrap();

        for table in [
            "memory_items",
            "memory_item_sources",
            "memory_embeddings",
            "memory_jobs",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assert_eq!(
                exists, 1,
                "memory table '{}' must exist after migrate",
                table
            );
        }

        // Indexes declared alongside the tables must also exist.
        for idx in ["idx_memory_item_sources_source", "idx_memory_jobs_status"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assert_eq!(exists, 1, "memory index '{}' must exist after migrate", idx);
        }
    }

    #[test]
    fn memory_items_source_type_check_rejects_invalid() {
        // source_type is constrained to the two supported extraction origins.
        let conn = setup();
        let now = 1_700_000_000i64;
        let bad = conn.execute(
            "INSERT INTO memory_items (id, text, source_type, created_at, updated_at)
             VALUES ('m1', 'likes black coffee', 'chat', ?1, ?1)",
            rusqlite::params![now],
        );
        assert!(
            bad.is_err(),
            "source_type='chat' must be rejected by CHECK constraint"
        );
    }

    #[test]
    fn memory_items_source_type_check_accepts_valid() {
        let conn = setup();
        let now = 1_700_000_000i64;
        for st in ["journal_entry", "daily_chat"] {
            let result = conn.execute(
                "INSERT INTO memory_items (id, text, source_type, created_at, updated_at)
                 VALUES (?1, 'fact', ?2, ?3, ?3)",
                rusqlite::params![format!("m-{st}"), st, now],
            );
            assert!(result.is_ok(), "source_type='{st}' should be accepted");
        }
    }

    #[test]
    fn memory_jobs_status_check_rejects_invalid() {
        let conn = setup();
        let now = 1_700_000_000i64;
        let bad = conn.execute(
            "INSERT INTO memory_jobs (source_type, source_id, content_hash, status, updated_at)
             VALUES ('journal_entry', 'e1', 'h', 'sent', ?1)",
            rusqlite::params![now],
        );
        assert!(
            bad.is_err(),
            "status='sent' must be rejected by memory_jobs CHECK constraint"
        );
    }

    #[test]
    fn memory_jobs_status_check_accepts_valid() {
        let conn = setup();
        let now = 1_700_000_000i64;
        for (i, st) in [
            "pending",
            "in_progress",
            "indexed",
            "skipped",
            "error",
            "paused",
        ]
        .iter()
        .enumerate()
        {
            let result = conn.execute(
                "INSERT INTO memory_jobs (source_type, source_id, content_hash, status, updated_at)
                 VALUES ('journal_entry', ?1, 'h', ?2, ?3)",
                rusqlite::params![format!("e{i}"), st, now],
            );
            assert!(result.is_ok(), "status='{st}' should be accepted");
        }
    }

    #[test]
    fn memory_jobs_pk_rejects_duplicate_source() {
        let conn = setup();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO memory_jobs (source_type, source_id, content_hash, updated_at)
             VALUES ('journal_entry', 'e1', 'h', ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO memory_jobs (source_type, source_id, content_hash, updated_at)
             VALUES ('journal_entry', 'e1', 'h2', ?1)",
            rusqlite::params![now],
        );
        assert!(
            dup.is_err(),
            "duplicate (source_type, source_id) must violate memory_jobs PK"
        );
    }

    #[test]
    fn memory_embeddings_pk_is_memory_id_and_model_id() {
        // An item can carry vectors for several models over time, but only
        // one row per (memory_id, model_id).
        let conn = setup();
        let now = 1_700_000_000i64;
        conn.execute(
            "INSERT INTO memory_embeddings (memory_id, model_id, dim, vec, content_hash, indexed_at)
             VALUES ('m1', 'on-device:mini', 384, X'AABB', 'h', ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        // Same memory_id, different model_id → ok.
        conn.execute(
            "INSERT INTO memory_embeddings (memory_id, model_id, dim, vec, content_hash, indexed_at)
             VALUES ('m1', 'ollama:nomic', 768, X'CCDD', 'h', ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        // Same (memory_id, model_id) → PK violation.
        let dup = conn.execute(
            "INSERT INTO memory_embeddings (memory_id, model_id, dim, vec, content_hash, indexed_at)
             VALUES ('m1', 'on-device:mini', 384, X'EEFF', 'h', ?1)",
            rusqlite::params![now],
        );
        assert!(
            dup.is_err(),
            "duplicate (memory_id, model_id) must violate memory_embeddings PK"
        );
    }

    #[test]
    fn memory_item_sources_pk_is_composite() {
        let conn = setup();
        conn.execute(
            "INSERT INTO memory_item_sources (memory_id, source_type, source_id)
             VALUES ('m1', 'journal_entry', 'e1')",
            [],
        )
        .unwrap();
        // Same memory_id + source_id but different source_type → ok.
        conn.execute(
            "INSERT INTO memory_item_sources (memory_id, source_type, source_id)
             VALUES ('m1', 'daily_chat', 'e1')",
            [],
        )
        .unwrap();
        // Exact triple duplicate → PK violation.
        let dup = conn.execute(
            "INSERT INTO memory_item_sources (memory_id, source_type, source_id)
             VALUES ('m1', 'journal_entry', 'e1')",
            [],
        );
        assert!(
            dup.is_err(),
            "duplicate (memory_id, source_type, source_id) must violate PK"
        );
    }

    fn ai_reviews_pk_columns(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM pragma_table_info('ai_reviews') WHERE pk > 0 ORDER BY pk")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn migrate_fresh_db_ai_reviews_pk_is_kind_and_period_range() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        assert_eq!(
            ai_reviews_pk_columns(&conn),
            vec!["kind", "period_start", "period_end"],
            "ai_reviews PK must be (kind, period_start, period_end)"
        );

        let has_model_id: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('ai_reviews') WHERE name='model_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_model_id, 1, "model_id must remain a non-key column");
    }

    #[test]
    fn migrate_rebuilds_legacy_ai_reviews_pk_and_sets_flag() {
        // Pre-period-PK dev DB: 4-column key plus a settings table, no flag.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE ai_reviews (
                kind            TEXT    NOT NULL,
                period_start    INTEGER NOT NULL,
                period_end      INTEGER NOT NULL,
                model_id        TEXT    NOT NULL,
                result_json     TEXT    NOT NULL,
                entry_count     INTEGER NOT NULL,
                created_at      INTEGER NOT NULL,
                PRIMARY KEY (kind, period_start, period_end, model_id)
             );
             CREATE INDEX ai_reviews_created_at_idx ON ai_reviews(created_at);
             INSERT INTO ai_reviews
                (kind, period_start, period_end, model_id, result_json, entry_count, created_at)
             VALUES ('weekly', 1, 2, 'model-a', '{}', 0, 0);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(
            ai_reviews_pk_columns(&conn),
            vec!["kind", "period_start", "period_end"],
            "legacy 4-column PK must rebuild to (kind, period_start, period_end)"
        );
        let flag: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_reviews_period_pk'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, "true", "one-shot flag must be set after rebuild");
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_reviews", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            row_count, 0,
            "dev mode wipes cached reviews — no row migration"
        );
    }

    #[test]
    fn migrate_ai_reviews_period_pk_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO ai_reviews
                (kind, period_start, period_end, model_id, result_json, entry_count, created_at)
             VALUES ('weekly', 1, 2, 'model-a', '{}', 0, 0)",
            [],
        )
        .unwrap();

        // Second call must not drop the table again.
        migrate(&conn).unwrap();

        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_reviews", [], |r| r.get(0))
            .unwrap();
        assert_eq!(row_count, 1, "second migrate() must not wipe ai_reviews");
        let flag: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_reviews_period_pk'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, "true");
    }

    #[test]
    fn ai_reviews_rejects_duplicate_period_with_different_model() {
        let conn = setup();
        conn.execute(
            "INSERT INTO ai_reviews
                (kind, period_start, period_end, model_id, result_json, entry_count, created_at)
             VALUES ('weekly', 1, 2, 'model-a', '{}', 0, 0)",
            [],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO ai_reviews
                (kind, period_start, period_end, model_id, result_json, entry_count, created_at)
             VALUES ('weekly', 1, 2, 'model-b', '{}', 0, 0)",
            [],
        );
        assert!(
            dup.is_err(),
            "same (kind, period_start, period_end) with a different model_id must violate the PK"
        );
    }
}
