import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';

// A user turn made entirely of tool results continues the agent's previous turn.
// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts
export const setInitiatorHeader = defineCopilotStage({
  name: 'copilot.anthropicMessages.setInitiatorHeader',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const request = facts['request.http'];
      const last = payload.messages.at(-1);
      const userInitiated = last?.role === 'user'
        && (!Array.isArray(last.content) || last.content.some(block => block.type !== 'tool_result'));
      const headers = setHeader(request.headers, 'x-initiator', userInitiated ? 'user' : 'agent');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
