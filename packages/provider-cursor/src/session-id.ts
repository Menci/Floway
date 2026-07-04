/**
 * Cursor session ID derivation.
 *
 * Determines a sessionKey for DurableHttpSession.acquire() so consecutive
 * tool-call turns reuse the same RunSSE stream. Uses the opencode-cursor-proxy
 * pattern: encode the sessionId into tool_call_id itself, so the OpenAI
 * protocol's mandatory id-echo becomes the session correlation signal.
 *
 * sessionKey format: `cursor:${upstreamId}:${apiKeyId}:${form}:${id}`
 *   - upstreamId: physical isolation (different cursor accounts)
 *   - apiKeyId: security isolation (same account, different callers)
 *   - form: 'hdr' (explicit header) | 'auto' (minted/recovered from tool_call_id)
 *   - id: the session identifier itself
 */

import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

const TOOL_CALL_PREFIX_RE = /^sess_([a-zA-Z0-9]+)__/;

export interface DeriveSessionKeyResult {
  /** null = no session correlation found; caller must mint a new key. */
  sessionKey: string | null;
  /** true = client is following up on a prior tool_call turn. */
  isFollowUp: boolean;
}

/**
 * Derive a sessionKey from the inbound request.
 *
 * Priority:
 *   1. Explicit `X-Floway-Conversation-Id` header (smart clients)
 *   2. `sess_<id>__` prefix parsed from tool_call_id in history
 *   3. null → caller must mint a new key
 */
export function deriveSessionKey(
  upstreamId: string,
  apiKeyId: string,
  headers: Headers,
  messages: ChatCompletionsPayload['messages'],
): DeriveSessionKeyResult {
  const scope = `cursor:${upstreamId}:${apiKeyId}`;

  const explicit = headers.get('x-floway-conversation-id');
  if (explicit) {
    return { sessionKey: `${scope}:hdr:${explicit}`, isFollowUp: true };
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'tool' && msg.tool_call_id) {
      const m = TOOL_CALL_PREFIX_RE.exec(msg.tool_call_id);
      if (m) return { sessionKey: `${scope}:auto:${m[1]}`, isFollowUp: true };
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const m = TOOL_CALL_PREFIX_RE.exec(tc.id);
        if (m) return { sessionKey: `${scope}:auto:${m[1]}`, isFollowUp: true };
      }
    }
  }

  return { sessionKey: null, isFollowUp: false };
}

/** Mint a fresh sessionKey (new conversation). */
export function mintSessionKey(upstreamId: string, apiKeyId: string): string {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `cursor:${upstreamId}:${apiKeyId}:auto:${id}`;
}

/** Extract the bare session id from a full sessionKey (last segment). */
function bareId(sessionKey: string): string {
  return sessionKey.split(':').pop()!;
}

/** The cursor exec identity needed to build an ExecMcpResult on a follow-up. */
export interface ExecRef {
  /** ExecClientMessage.id (field 1). */
  id: number;
  /** exec_id (field 15); may be absent. */
  execId: string | undefined;
}

/**
 * Wrap: encode the session id AND the cursor exec identity (id + exec_id) into
 * the OpenAI-facing tool_call_id. The OpenAI protocol echoes tool_call_id back
 * verbatim on the follow-up tool message, so the follow-up — possibly on a
 * different instance — can rebuild the ExecMcpResult straight from the client's
 * id, with no server-side pending-exec map. `__` is the delimiter; cursor ids
 * use single underscores only (`call_…`, `fc_…`).
 */
export function wrapToolCallId(sessionKey: string, exec: ExecRef): string {
  return `sess_${bareId(sessionKey)}__${exec.id}__${exec.execId ?? ''}`;
}

/** Decode the cursor exec identity from a wrapped tool_call_id, or null. */
export function decodeToolCallId(wrapped: string): ExecRef | null {
  const m = TOOL_CALL_PREFIX_RE.exec(wrapped);
  if (!m) return null;
  const rest = wrapped.slice(m[0].length); // `${id}__${execId}`
  const sep = rest.indexOf('__');
  const idStr = sep === -1 ? rest : rest.slice(0, sep);
  const execIdStr = sep === -1 ? '' : rest.slice(sep + 2);
  const id = Number(idStr);
  if (!Number.isInteger(id)) return null;
  return { id, execId: execIdStr === '' ? undefined : execIdStr };
}
