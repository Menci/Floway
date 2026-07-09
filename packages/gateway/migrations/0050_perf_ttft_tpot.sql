-- packages/gateway/migrations/0050_perf_ttft_tpot.sql

DROP TABLE IF EXISTS performance_latency_buckets;
DROP TABLE IF EXISTS performance_summary;
DROP TABLE IF EXISTS performance_buckets;

CREATE TABLE performance_summary (
  hour             TEXT    NOT NULL,
  key_id           TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  upstream         TEXT    NOT NULL,
  operation        TEXT    NOT NULL,
  runtime_location TEXT    NOT NULL DEFAULT 'unknown',
  requests         INTEGER NOT NULL DEFAULT 0,
  errors           INTEGER NOT NULL DEFAULT 0,
  samples          INTEGER NOT NULL DEFAULT 0,
  ttft_ms_sum      INTEGER NOT NULL DEFAULT 0,
  tpot_us_sum      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model, upstream, operation, runtime_location)
);

CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE performance_buckets (
  hour             TEXT    NOT NULL,
  key_id           TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  upstream         TEXT    NOT NULL,
  operation        TEXT    NOT NULL,
  runtime_location TEXT    NOT NULL DEFAULT 'unknown',
  metric           TEXT    NOT NULL CHECK (metric IN ('ttft_ms', 'tpot_us')),
  lower            INTEGER NOT NULL,
  upper            INTEGER,
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model, upstream, operation, runtime_location, metric, lower)
);

CREATE INDEX idx_performance_buckets_hour ON performance_buckets (hour);
