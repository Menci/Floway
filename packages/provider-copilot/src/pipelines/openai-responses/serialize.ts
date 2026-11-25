import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';

// https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts
export const serializeOpenAIResponses = defineCopilotStage({
  name: 'copilot.openaiResponses.serialize',
  through: {
    request: { needs: ['request.openaiResponses', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const body = { ...facts['request.openaiResponses'], model: facts['copilot.modelId'], stream: true };
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/responses', body) };
    },
  })),
});
