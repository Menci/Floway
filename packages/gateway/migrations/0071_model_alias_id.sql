-- Give aliases an opaque id so the control plane addresses a row the same way
-- it addresses every other resource (`/api/aliases/:id`). Keying the routes on
-- the alias name broke every name carrying a `/` — a shape model ids use
-- routinely (`openai/gpt-5`) — because the path segment could not round-trip.
-- `name` keeps its uniqueness: it is still the public model id the data plane
-- resolves.

CREATE TABLE model_aliases_with_id (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  selection TEXT NOT NULL CHECK (selection IN ('random', 'first-available')),
  display_name TEXT,
  visible_in_models_list INTEGER NOT NULL DEFAULT 1 CHECK (visible_in_models_list IN (0, 1)),
  targets TEXT NOT NULL,
  announced_metadata_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO model_aliases_with_id (
  id,
  name,
  kind,
  selection,
  display_name,
  visible_in_models_list,
  targets,
  announced_metadata_json,
  sort_order,
  created_at,
  updated_at
)
SELECT
  'alias_' || lower(hex(randomblob(12))),
  name,
  kind,
  selection,
  display_name,
  visible_in_models_list,
  targets,
  announced_metadata_json,
  sort_order,
  created_at,
  updated_at
FROM model_aliases;

DROP TABLE model_aliases;
ALTER TABLE model_aliases_with_id RENAME TO model_aliases;
CREATE INDEX idx_model_aliases_sort ON model_aliases (sort_order, created_at);
