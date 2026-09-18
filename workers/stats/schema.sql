-- Schema for the `memlore-stats` D1 database.
--
-- Two tables, two different questions. Never add them up:
--
--   downloads  Website redirect log. One row per hit on dl.memlore.app/mac, so it
--              has a country but only sees people who came through the site —
--              a download straight off the GitHub Releases page is invisible here.
--
--   snapshots  Daily copy of GitHub's *cumulative* download_count per release
--              asset. Covers every source including direct Releases-page
--              downloads, but has no country, and a daily figure has to be
--              derived as a delta (see queries/), never read off `count`.
--
-- Re-applying this file is safe: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ISO-8601 UTC, deliberately truncated to the minute (YYYY-MM-DDTHH:MM:00Z).
  -- Kept only for debugging: no query reads finer than `day`. An exact instant
  -- is the one value here precise enough to line a row up with a Cloudflare edge
  -- log entry (which does carry an IP) and re-identify a single visitor, so the
  -- seconds are dropped at write time in src/index.ts.
  ts TEXT NOT NULL,
  day TEXT NOT NULL,      -- YYYY-MM-DD (UTC), for grouping
  version TEXT NOT NULL,  -- resolved app version, or 'unknown' on the fallback path
  country TEXT NOT NULL,  -- request.cf.country, or 'XX' when unavailable
  platform TEXT NOT NULL  -- 'mac'
);

CREATE INDEX IF NOT EXISTS idx_downloads_day ON downloads(day);

-- Composite primary key: the cron re-running for the same day overwrites its own
-- rows via INSERT OR REPLACE instead of duplicating them.
CREATE TABLE IF NOT EXISTS snapshots (
  day TEXT NOT NULL,
  tag TEXT NOT NULL,
  asset TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, tag, asset)
);
