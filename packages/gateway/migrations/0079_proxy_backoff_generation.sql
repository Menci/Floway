-- A dial can settle after its proxy config changes or the proxy is deleted. Give
-- every dial-config generation a monotonically increasing, bounded revision so an
-- A -> B -> A edit cannot make an old A outcome current again. Backoff rows
-- retain only that integer, not another copy of a potentially very large URL.
ALTER TABLE proxies
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991);

-- The allocator survives proxy deletion and replace imports, so recreating the
-- same id cannot reuse an in-flight request's generation. A fresh deployment
-- starts at zero; one with pre-existing proxies reserves revision 1 for them.
CREATE TABLE proxy_revision_counter (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision  INTEGER NOT NULL
    CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
);

INSERT INTO proxy_revision_counter (singleton, revision)
SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM proxies) THEN 1 ELSE 0 END;

ALTER TABLE proxy_upstream_backoffs RENAME TO proxy_upstream_backoffs_pre_0079;

CREATE TABLE proxy_upstream_backoffs (
  proxy_id       TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  upstream_id    TEXT NOT NULL,
  proxy_revision INTEGER NOT NULL
    CHECK (typeof(proxy_revision) = 'integer' AND proxy_revision BETWEEN 1 AND 9007199254740991),
  fail_count     INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  last_error     TEXT,
  last_error_at  INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);

INSERT INTO proxy_upstream_backoffs
  (proxy_id, upstream_id, proxy_revision, fail_count, expires_at, last_error, last_error_at)
SELECT b.proxy_id, b.upstream_id, p.revision, b.fail_count, b.expires_at, b.last_error, b.last_error_at
FROM proxy_upstream_backoffs_pre_0079 b
JOIN proxies p ON p.id = b.proxy_id;

DROP TABLE proxy_upstream_backoffs_pre_0079;
