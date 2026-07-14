-- Per-upstream badge color override.
-- NULL keeps today's kind-defaulted tone; a value starting with '#' is a raw
-- #RRGGBB hex; anything else is a preset key resolved on the frontend.
-- D1 does not support clean DROP COLUMN on old-format tables — a rollback
-- keeps this column and ignores its value in code.
ALTER TABLE upstreams ADD COLUMN color TEXT NULL;
