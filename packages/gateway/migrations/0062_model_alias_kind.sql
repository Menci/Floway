CREATE TABLE model_aliases_with_open_kind (
  name TEXT PRIMARY KEY,
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

INSERT INTO model_aliases_with_open_kind (
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
ALTER TABLE model_aliases_with_open_kind RENAME TO model_aliases;
CREATE INDEX idx_model_aliases_sort ON model_aliases (sort_order, created_at);
