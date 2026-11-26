/**
 * Parse Claude Code's `metadata.user_id` fingerprint into
 * `{ safetyIdentifier, sessionId }`. Two formats coexist in the wild:
 *
 *   1. Legacy textual form: `user_<id>_account__session_<sid>` (regex below
 *      extracts the two halves independently).
 *   2. Modern JSON form: a JSON object carrying at least `device_id` /
 *      `account_uuid` and `session_id` fields.
 *
 * If both legacy halves match, we use the legacy values directly and never
 * attempt JSON parsing — Claude Code never combines the two formats, and
 * skipping the parse avoids a thrown `SyntaxError` allocation on the hot path.
 *
 * Used by withClaudeAgentHeadersSet (needs BOTH halves to fire) and by
 * withInteractionIdHeaderSet (needs only sessionId).
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L151
 */

const LEGACY_SAFETY_IDENTIFIER_RE = /user_([^_]+)_account/;
const LEGACY_SESSION_ID_RE = /_session_(.+)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (payload: Record<string, unknown> | null, field: string): string | null => {
  const value = payload?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const parseJsonUserId = (userId: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(userId);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export interface ClaudeCodeMetadata {
  safetyIdentifier: string | null;
  sessionId: string | null;
}

export const parseUserIdMetadata = (userId: string | undefined): ClaudeCodeMetadata => {
  if (!userId) return { safetyIdentifier: null, sessionId: null };

  const legacySafetyIdentifier = userId.match(LEGACY_SAFETY_IDENTIFIER_RE)?.[1] ?? null;
  const legacySessionId = userId.match(LEGACY_SESSION_ID_RE)?.[1] ?? null;

  const parsed = legacySafetyIdentifier && legacySessionId ? null : parseJsonUserId(userId);

  return {
    safetyIdentifier: legacySafetyIdentifier ?? stringField(parsed, 'device_id') ?? stringField(parsed, 'account_uuid'),
    sessionId: legacySessionId ?? stringField(parsed, 'session_id'),
  };
};
