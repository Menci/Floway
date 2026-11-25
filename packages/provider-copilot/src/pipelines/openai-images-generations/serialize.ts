import { defineCopilotStage } from '../facts.ts';
import { serializeJsonRequest } from '../shared/json.ts';
import { transform } from '@floway-dev/pipeline';

// https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/image-generation
export const serializeOpenAIImagesGenerations = defineCopilotStage({
  name: 'copilot.openaiImagesGenerations.serialize',
  through: {
    request: { needs: ['request.openaiImagesGenerations', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const body = { ...facts['request.openaiImagesGenerations'], model: facts['copilot.modelId'] };
      return { ...facts, 'request.http': serializeJsonRequest(facts['request.http'], '/v1/images/generations', body) };
    },
  })),
});
