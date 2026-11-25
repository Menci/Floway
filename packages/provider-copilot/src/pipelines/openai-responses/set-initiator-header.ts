import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';

// Items without a role include tool outputs. An assistant message is also a replay rather than a new user turn.
// https://github.com/caozhiyuan/copilot-api/blob/cd8207cb70ede07771bf37a04accfbf2af76d980/src/routes/responses/utils.ts#L75-L87
export const setInitiatorHeader = defineCopilotStage({
  name: 'copilot.openaiResponses.setInitiatorHeader',
  through: {
    request: { needs: ['request.openaiResponses', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      const request = facts['request.http'];
      const last = payload.input.at(-1);
      const role = (last as { role?: unknown } | undefined)?.role;
      const agentInitiated = last !== undefined && (role === undefined || role === null || role === '' || role === 'assistant');
      const headers = setHeader(request.headers, 'x-initiator', agentInitiated ? 'agent' : 'user');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
