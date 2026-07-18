-- Agent Setup leases. A dashboard page acquires a lease (POST), which issues a
-- random `token` embedded in the public setup-script URL a user runs on their
-- machine. The token is the primary key: a user may hold many concurrent
-- leases at once (one per open page), each edited independently. Configuration
-- edits (PUT) advance `configuration_revision` under optimistic concurrency;
-- heartbeats only extend `expires_at`. A page's writes only ever match its own
-- token, so pages never supersede one another.
CREATE TABLE agent_setup (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  configuration_json TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL,
  -- Unix milliseconds.
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Deterministic latest-row selection for restore-on-reopen.
CREATE INDEX idx_agent_setup_user_latest
  ON agent_setup (user_id, updated_at DESC, created_at DESC, token DESC);

-- After a new lease is inserted, drop only the same user's already-expired
-- rows, measured against the new row's created_at. The `token <> NEW.token`
-- guard makes it impossible to delete the freshly inserted row, and its future
-- expiry would not match the predicate anyway; no unexpired row is ever swept.
CREATE TRIGGER agent_setup_sweep_expired AFTER INSERT ON agent_setup
BEGIN
  DELETE FROM agent_setup
   WHERE user_id = NEW.user_id
     AND token <> NEW.token
     AND expires_at <= NEW.created_at;
END;
