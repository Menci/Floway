-- Codex maps its client-only Ultra selection to `max` on Responses requests.
-- https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/client.rs#L175-L180
CREATE TABLE codex_ultra_config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  redirect_effort  TEXT NOT NULL DEFAULT 'max',
  updated_at       TEXT NOT NULL
);

INSERT INTO codex_ultra_config (id, enabled, redirect_effort, updated_at)
VALUES (1, 0, 'max', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
