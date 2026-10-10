ALTER TABLE upstreams ADD COLUMN usage_refresh_interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK (usage_refresh_interval_minutes >= 0);

CREATE TABLE upstream_scheduled_tasks (
  upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  claim_token TEXT,
  next_attempt_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error TEXT,
  PRIMARY KEY (upstream_id, task)
);
