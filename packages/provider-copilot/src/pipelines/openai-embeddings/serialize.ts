import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';

// https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts
export const serializeOpenAIEmbeddings = defineCopilotStage({
  name: 'copilot.openaiEmbeddings.serialize',
  through: {
    request: { needs: ['request.openaiEmbeddings', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const body = { ...facts['request.openaiEmbeddings'], model: facts['copilot.modelId'] };
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/embeddings', body) };
    },
  })),
});
