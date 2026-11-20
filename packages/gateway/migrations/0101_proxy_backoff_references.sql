-- Backoff rows describe a (proxy, upstream) pair, so both halves now reference
-- their parent rows and disappear with them. Rows whose parent is already gone
-- carry no state the dial layer can reach, so the rebuild drops them; that
-- includes rows that edit-form probes recorded under the synthetic upstream id
-- 'draft'. upstream_id gets its own index because cascading deletes and
-- per-upstream reads both look it up without the leading proxy_id.
CREATE TABLE proxy_upstream_backoffs_new (
  proxy_id      TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  upstream_id   TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  last_error    TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);

INSERT INTO proxy_upstream_backoffs_new (proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at)
SELECT b.proxy_id, b.upstream_id, b.fail_count, b.expires_at, b.last_error, b.last_error_at
FROM proxy_upstream_backoffs b
WHERE EXISTS (SELECT 1 FROM proxies p WHERE p.id = b.proxy_id)
  AND EXISTS (SELECT 1 FROM upstreams u WHERE u.id = b.upstream_id);

DROP TABLE proxy_upstream_backoffs;
ALTER TABLE proxy_upstream_backoffs_new RENAME TO proxy_upstream_backoffs;
CREATE INDEX idx_proxy_upstream_backoffs_upstream ON proxy_upstream_backoffs (upstream_id);
