CREATE TABLE oauth2_accounts (
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, provider_user_id),
  UNIQUE (provider_id, user_id)
);
CREATE INDEX idx_oauth2_accounts_user ON oauth2_accounts(user_id);

-- Only hashes of browser-visible bearer values are persisted. An authorization
-- row is consumed before the upstream code exchange, making OAuth2 state
-- single-use even if the provider retries the callback.
CREATE TABLE oauth2_authorizations (
  state_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  browser_verifier_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth2_authorizations_expiry ON oauth2_authorizations(expires_at);

-- The callback redirects with a one-time value in the URL fragment. Existing
-- accounts carry user_id; new identities retain the provider claims until the
-- visitor chooses a Floway username and completes registration.
CREATE TABLE oauth2_handoffs (
  token_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_login TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth2_handoffs_expiry ON oauth2_handoffs(expires_at);
