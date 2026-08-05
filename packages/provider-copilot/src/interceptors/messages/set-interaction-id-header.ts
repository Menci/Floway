import { v4 } from 'uuid';

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
  return v4({ random: new Uint8Array(await crypto.subtle.digest('SHA-256', data)) });
};

export const withInteractionIdHeaderSet: CopilotMessagesBoundaryInterceptor = async (ctx, _env, run) => {
  const { sessionId } = parseUserIdMetadata(ctx.payload.metadata?.user_id);
  if (sessionId) {
    ctx.headers.set('x-interaction-id', await sessionUuid(sessionId));
  }
  return await run();
};
