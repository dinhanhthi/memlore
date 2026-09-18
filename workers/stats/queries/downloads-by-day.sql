-- Website redirects per day, split by the version that was served.
-- Source: dl.memlore.app/mac hits only. Blind spot: downloads taken straight
-- from the GitHub Releases page are not in here (see totals-by-version.sql).
SELECT day, version, COUNT(*) AS downloads
FROM downloads
WHERE day >= date('now', '-90 days')
GROUP BY day, version
ORDER BY day DESC, version;
