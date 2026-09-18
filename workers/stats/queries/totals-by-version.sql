-- Cumulative .dmg downloads per release, as GitHub last reported them.
-- Source: the newest snapshot row per (tag, asset). Covers every source,
-- including the Releases page. Blind spot: no country, and no history before
-- the first cron run.
SELECT s.tag, s.asset, s.count AS total, s.day AS as_of
FROM snapshots s
WHERE s.asset LIKE '%.dmg'
  AND s.day = (SELECT MAX(day) FROM snapshots n WHERE n.tag = s.tag AND n.asset = s.asset)
ORDER BY s.tag DESC, s.asset;
