CREATE TABLE groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_groups_name_active ON groups(name) WHERE deleted_at IS NULL;

CREATE TABLE group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id, group_id);
