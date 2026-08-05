import { hex } from '@scure/base';

import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import type { CopilotMessagesBoundaryInterceptor } from './types.ts';

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
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16);
  // RFC 4122 §4.4 layout: stamp version 4 in the high nibble of byte 6 and
  // variant 10 in the high two bits of byte 8.
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const encoded = hex.encode(digest);
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
};

export const withInteractionIdHeaderSet: CopilotMessagesBoundaryInterceptor = async (ctx, _env, run) => {
  const { sessionId } = parseUserIdMetadata(ctx.payload.metadata?.user_id);
  if (sessionId) {
    ctx.headers.set('x-interaction-id', await sessionUuid(sessionId));
  }
  return await run();
};
