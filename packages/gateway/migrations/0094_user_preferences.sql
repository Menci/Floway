CREATE TABLE user_preferences (
  user_id INTEGER PRIMARY KEY,
  preferences_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
