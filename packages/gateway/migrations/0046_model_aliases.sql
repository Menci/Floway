CREATE TABLE model_aliases (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'embedding', 'image')),
  selection TEXT NOT NULL CHECK (selection IN ('random', 'first-available')),
  display_name TEXT,
  visible_in_models_list INTEGER NOT NULL DEFAULT 1 CHECK (visible_in_models_list IN (0, 1)),
  targets TEXT NOT NULL,
  -- Operator-set override for the `limits` + `chat.*` block surfaced on
  -- /v1/models. NULL keeps the automatic, rule-aware intersection across
  -- the alias's targets; a non-null value is a JSON-encoded
  -- AnnouncedMetadata. Fallback is at the top-level sub-block boundary
  -- (`limits` / `chat`), not per-leaf.
  announced_metadata_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_model_aliases_sort ON model_aliases (sort_order, created_at);

