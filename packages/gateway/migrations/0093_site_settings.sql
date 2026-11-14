-- Operator-owned branding for this deployment. A NULL site name means the
-- deployment has not overridden the wordmark, so the dashboard renders its
-- built-in default; storing that default here would freeze it at the value the
-- row happened to be seeded with.
--
-- The row is readable without a session because the sign-in page carries the
-- wordmark before anyone authenticates, so nothing secret belongs in this
-- table.
CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_name TEXT CHECK (site_name IS NULL OR length(site_name) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL
);

INSERT INTO site_settings (id, site_name, updated_at)
VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
