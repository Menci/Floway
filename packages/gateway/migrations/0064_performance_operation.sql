CREATE TABLE performance_summary_with_open_operation (
  hour               TEXT    NOT NULL,
  key_id             TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  upstream           TEXT    NOT NULL,
  operation          TEXT    NOT NULL CHECK (length(operation) > 0),
  runtime_location   TEXT    NOT NULL DEFAULT 'unknown',
  requests           INTEGER NOT NULL DEFAULT 0,
  ttft_samples_ok    INTEGER NOT NULL DEFAULT 0,
  errors_with_output INTEGER NOT NULL DEFAULT 0,
  errors_no_output   INTEGER NOT NULL DEFAULT 0,
  neutral            INTEGER NOT NULL DEFAULT 0,
  tpot_samples       INTEGER NOT NULL DEFAULT 0,
  ttft_ms_sum        INTEGER NOT NULL DEFAULT 0,
  tpot_us_sum        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model, upstream, operation, runtime_location)
);

INSERT INTO performance_summary_with_open_operation (
  hour, key_id, model, upstream, operation, runtime_location,
  requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
  tpot_samples, ttft_ms_sum, tpot_us_sum
)
SELECT
  hour, key_id, model, upstream, operation, runtime_location,
  requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
  tpot_samples, ttft_ms_sum, tpot_us_sum
FROM performance_summary;

DROP TABLE performance_summary;
ALTER TABLE performance_summary_with_open_operation RENAME TO performance_summary;
CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE performance_buckets_with_open_operation (
  hour             TEXT    NOT NULL,
  key_id           TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  upstream         TEXT    NOT NULL,
  operation        TEXT    NOT NULL CHECK (length(operation) > 0),
  runtime_location TEXT    NOT NULL DEFAULT 'unknown',
  metric           TEXT    NOT NULL CHECK (metric IN ('ttft_ms', 'tpot_us')),
  lower            INTEGER NOT NULL,
  upper            INTEGER,
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model, upstream, operation, runtime_location, metric, lower)
);

INSERT INTO performance_buckets_with_open_operation (
  hour, key_id, model, upstream, operation, runtime_location,
  metric, lower, upper, count
)
SELECT
  hour, key_id, model, upstream, operation, runtime_location,
  metric, lower, upper, count
FROM performance_buckets;

DROP TABLE performance_buckets;
ALTER TABLE performance_buckets_with_open_operation RENAME TO performance_buckets;
CREATE INDEX idx_performance_buckets_hour ON performance_buckets (hour);
