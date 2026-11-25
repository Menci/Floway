import { v4 } from 'uuid';

import { defineCopilotStage } from '../facts.ts';
import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
const sessionUuid = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  return v4({ random: new Uint8Array(await crypto.subtle.digest('SHA-256', data)) });
};
// Derive a stable opaque identifier without forwarding the Claude Code session ID.
// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/lib/api-config.ts
export const setInteractionIdHeader = defineCopilotStage({
  name: 'copilot.anthropicMessages.setInteractionIdHeader',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    async request(facts) {
      const payload = facts['request.anthropicMessages'];
      const request = facts['request.http'];
      const { sessionId } = parseUserIdMetadata('metadata' in payload ? payload.metadata?.user_id ?? undefined : undefined);
      if (!sessionId) return facts;
      const headers = setHeader(request.headers, 'x-interaction-id', await sessionUuid(sessionId));
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
