import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
import { serializeOpenAIImagesEditsHttpBody } from '@floway-dev/provider';

// https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/image-generation
export const serializeOpenAIImagesEdits = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.serialize',
  through: {
    request: { needs: ['request.openaiImagesEdits', 'request.http', 'copilot.modelId'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    async request(facts) {
      const request = facts['request.http'];
      const { body, contentType } = await serializeOpenAIImagesEditsHttpBody(facts['request.openaiImagesEdits'], facts['copilot.modelId']);
      return {
        ...facts,
        'request.http': move({
          ...request,
          method: 'POST',
          url: '/v1/images/edits',
          headers: setHeader(request.headers, 'content-type', contentType),
          body,
        }),
      };
    },
  })),
});
