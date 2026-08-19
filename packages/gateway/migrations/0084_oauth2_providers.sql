-- Operator-managed OAuth2 provider configuration. Account bindings deliberately
-- do not reference this table: deleting a provider disables login without
-- destroying user bindings, and recreating the same provider id restores them.
CREATE TABLE oauth2_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_base_url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO oauth2_settings (id, public_base_url, updated_at)
VALUES (1, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE oauth2_providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  userinfo_endpoint TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  client_authentication TEXT NOT NULL CHECK (client_authentication IN ('client_secret_post', 'client_secret_basic')),
  user_id_claim TEXT,
  username_claim TEXT,
  authorization_params_json TEXT NOT NULL CHECK (json_valid(authorization_params_json) AND json_type(authorization_params_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_oauth2_providers_enabled_created
ON oauth2_providers(enabled, created_at, id);
