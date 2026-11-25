import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';

// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts
export const serializeAnthropicMessages = defineCopilotStage({
  name: 'copilot.anthropicMessages.serialize',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const body = { ...facts['request.anthropicMessages'], model: facts['copilot.modelId'], stream: true };
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/v1/messages', body) };
    },
  })),
});
