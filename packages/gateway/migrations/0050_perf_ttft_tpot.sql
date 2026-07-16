DROP TABLE IF EXISTS performance_latency_buckets;
DROP TABLE IF EXISTS performance_summary;
DROP TABLE IF EXISTS performance_buckets;

-- Partition-first counters: every request bumps exactly one of the four
-- disjoint counters (their sum equals `requests` by construction), which
-- lets the aggregator derive display-friendly totals without inclusion-
-- exclusion arithmetic that could go negative on a corrupted row.
--
-- - ttft_samples_ok: successful streams that produced a first-token stamp
--   (contribute to TTFT / TPOT percentiles).
-- - errors_with_output: failures that streamed at least one token before
--   dying — they still yield a TTFT sample so the dashboard sees upstream
--   latency during instability windows, but count against errors, not
--   against the healthy TTFT bucket.
-- - errors_no_output: pre-stream / usage-never-arrived failures with zero
--   tokens.
-- - neutral: successes with no TTFT (non-chat / no upstream call /
--   detector never fired).
--
-- Aggregate views compose:
--   ttft_samples = ttft_samples_ok + errors_with_output
--   errors       = errors_with_output + errors_no_output
--
-- `tpot_samples` is orthogonal — the subset of TTFT-carrying rows that
-- also had a second output token, so it stays as its own counter and
-- indexes back into `ttft_samples`.
CREATE TABLE performance_summary (
  hour               TEXT    NOT NULL,
  key_id             TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  upstream           TEXT    NOT NULL,
  operation          TEXT    NOT NULL CHECK (operation IN ('chat', 'text_completion', 'embeddings', 'image_generation', 'image_edit')),
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

CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE performance_buckets (
  hour             TEXT    NOT NULL,
  key_id           TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  upstream         TEXT    NOT NULL,
  operation        TEXT    NOT NULL CHECK (operation IN ('chat', 'text_completion', 'embeddings', 'image_generation', 'image_edit')),
  runtime_location TEXT    NOT NULL DEFAULT 'unknown',
  metric           TEXT    NOT NULL CHECK (metric IN ('ttft_ms', 'tpot_us')),
  lower            INTEGER NOT NULL,
  upper            INTEGER,
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model, upstream, operation, runtime_location, metric, lower)
);

CREATE INDEX idx_performance_buckets_hour ON performance_buckets (hour);
