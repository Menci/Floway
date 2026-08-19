ALTER TABLE oauth2_providers
ADD COLUMN access_policy_json TEXT NOT NULL DEFAULT '{"type":"allow_all"}'
CHECK (json_valid(access_policy_json) AND json_type(access_policy_json) = 'object');

ALTER TABLE oauth2_authorizations
ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
