CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64)
);

INSERT INTO site_settings (id, name) VALUES (1, 'Floway');
