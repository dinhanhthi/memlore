-- Website redirects grouped by country, split by version.
-- Source: dl.memlore.app/mac hits only, country from request.cf.country
-- ('XX' when Cloudflare did not supply one). No IP is ever stored.
SELECT country, version, COUNT(*) AS downloads
FROM downloads
GROUP BY country, version
ORDER BY downloads DESC, country, version;
