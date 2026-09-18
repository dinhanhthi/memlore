-- Approximate daily app launches: the updater fetches latest.json once per
-- launch, so the day-over-day growth of its download_count tracks launches.
-- snapshots.count is CUMULATIVE, so the daily figure must be a LAG delta --
-- reading `count` directly would report the running total.
-- Approximation: CDN caching, non-updater fetches and multiple launches per
-- day per device all distort it. Treat it as a trend, not a user count.
-- `days` is how many days the delta spans: 1 normally, and anything higher means
-- a cron run was skipped and that many days of activity were merged into the one
-- row -- so `launches` is a sum over `days`, not a daily figure.
SELECT day, tag, launches, days
FROM (
  SELECT day, tag,
         count - LAG(count) OVER (PARTITION BY tag, asset ORDER BY day) AS launches,
         CAST(
           julianday(day) - julianday(LAG(day) OVER (PARTITION BY tag, asset ORDER BY day))
           AS INTEGER
         ) AS days
  FROM snapshots
  WHERE asset = 'latest.json'
)
WHERE launches IS NOT NULL
ORDER BY day DESC, tag;
