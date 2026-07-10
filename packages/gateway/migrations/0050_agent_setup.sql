-- Per-user Agent Setup lease. A dashboard tab acquires a lease (POST), which
-- issues a random `token`; the token is embedded in the public setup-script
-- URL a user runs on their machine. Configuration edits (PUT) advance
-- `configuration_revision` under optimistic concurrency; heartbeats only
-- extend `expires_at`. A newer lease supersedes an older one by replacing the
-- `token`, so a stale tab's writes stop matching.
CREATE TABLE agent_setup (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL,
  -- External origin (scheme + host) the dashboard was loaded from, captured
  -- at lease creation. A Node deployment behind a TLS-terminating reverse
  -- proxy cannot recover the public scheme from the inbound request URL, so
  -- the authenticated client sends `window.location.origin` explicitly and it
  -- is echoed into the rendered setup script.
  public_base_url TEXT NOT NULL,
  -- Unix milliseconds.
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_agent_setup_token ON agent_setup (token);
