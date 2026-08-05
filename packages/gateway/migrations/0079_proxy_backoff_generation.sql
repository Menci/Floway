-- A dial can settle after its proxy URL changes or the proxy is deleted. Keep
-- the attempted URL on the row so only the current endpoint generation can
-- create, advance, or clear its cooldown; the FK makes deletion atomic with
-- backoff cleanup and rejects any write outside the repository guard.
ALTER TABLE proxy_upstream_backoffs RENAME TO proxy_upstream_backoffs_pre_0079;

CREATE TABLE proxy_upstream_backoffs (
  proxy_id      TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  upstream_id   TEXT NOT NULL,
  proxy_url     TEXT NOT NULL,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  last_error    TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);

INSERT INTO proxy_upstream_backoffs
  (proxy_id, upstream_id, proxy_url, fail_count, expires_at, last_error, last_error_at)
SELECT b.proxy_id, b.upstream_id, p.url, b.fail_count, b.expires_at, b.last_error, b.last_error_at
FROM proxy_upstream_backoffs_pre_0079 b
JOIN proxies p ON p.id = b.proxy_id;

DROP TABLE proxy_upstream_backoffs_pre_0079;
