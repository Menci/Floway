-- D1/sqlite table backing cross-instance Cursor session reuse.
--
-- A Cursor agent turn keeps a long-lived RunSSE read stream open (held by the
-- DurableHttpSession) plus a monotonic BidiAppend write `seqno`. When a
-- tool-result follow-up lands on a DIFFERENT isolate, the in-process transport
-- is gone — so the two scalars needed to resume (the upstream `request_id` and
-- the next `append_seqno`) live here in D1 instead, keyed by session.
--
-- `leftover` carries any RunSSE bytes the prior turn's frame parser read past
-- the exec_mcp frame but did not consume (usually empty — Cursor pauses right
-- after exec_mcp). The blobStore is NOT stored: Cursor only ever set_blob's
-- (write-only sink), so a follow-up instance starts with an empty one.
--
-- `locked_until` is a single-flight claim lock (unix ms): a follow-up CAS-claims
-- the row before resuming so two concurrent follow-ups can't both drive the
-- same stream and corrupt the seqno; the loser falls back to cold-resume.
--
-- Rows are short-lived (a live conversation turn, not durable history) and are
-- swept by the maintenance cron against `refreshed_at`.
CREATE TABLE cursor_sessions (
  session_key  TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL,
  append_seqno INTEGER NOT NULL,
  leftover     BLOB,
  locked_until INTEGER,        -- unix ms; NULL = unclaimed
  created_at   INTEGER NOT NULL, -- unix ms
  refreshed_at INTEGER NOT NULL  -- unix ms; cron sweeps by this
);

CREATE INDEX idx_cursor_sessions_refreshed_at ON cursor_sessions(refreshed_at);
