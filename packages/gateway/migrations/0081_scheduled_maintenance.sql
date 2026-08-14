CREATE TABLE scheduled_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  claim_token TEXT,
  claimed_at INTEGER,
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);

INSERT INTO scheduled_maintenance (singleton) VALUES (1);
