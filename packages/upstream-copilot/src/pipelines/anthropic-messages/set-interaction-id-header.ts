import { v4 } from 'uuid';

import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { defineCopilotStage } from '../facts.ts';
import type { HttpHeaders } from '@floway-dev/http';
import { setHeader } from '@floway-dev/http';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

/**
 * Copilot's `x-interaction-id` header threads a conversation through its
 * accounting and trace tooling. We hash the raw session identifier through
 * SHA-256 and format the first 16 bytes as a UUID v4 string, so the on-wire
 * value stays a UUID-shaped opaque identifier rather than leaking the
 * upstream client's raw session id. Same input → same UUID, so trace
 * correlation across requests still works.
 *
 * Fires whenever `parseUserIdMetadata` produces a `sessionId`, regardless of
 * whether the safety-identifier half is also present.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/api-config.ts (prepareInteractionHeaders, getRootSessionId)
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L217 (getRootSessionId)
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L230 (getUUID)
 */
const sessionUuid = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  return v4({ random: new Uint8Array(await crypto.subtle.digest('SHA-256', data)) });
};

const shapeSetInteractionIdHeader = async (payload: Pick<AnthropicMessagesPayload, 'messages' | 'metadata' | 'system' | 'thinking'>, headers: HttpHeaders): Promise<HttpHeaders> => {
  const { sessionId } = parseUserIdMetadata(payload.metadata?.user_id ?? undefined);
  return sessionId ? setHeader(headers, 'x-interaction-id', await sessionUuid(sessionId)) : headers;
};

export const setInteractionIdHeader = defineCopilotStage({
  name: 'copilot.anthropicMessages.setInteractionIdHeader',
  through: {
    request: { needs: ['anthropicMessages', 'http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.anthropicMessages;
    const headers = await shapeSetInteractionIdHeader(payload, facts.http.headers);
    return await scope.next(headers === facts.http.headers ? facts : { ...facts, http: { ...facts.http, headers } });
  },
});
