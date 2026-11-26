import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { prepareJsonModelRequest } from '../shared/json-model-request.ts';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';

export const openaiImagesError = (message: string) => ({ error: { message, type: 'api_error' } });

export const parseOpenAIImagesGenerations = defineStage({
  name: 'openaiImagesGenerations.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiImagesGenerations'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const parsed = prepareJsonModelRequest(facts['request.http'].body ?? new Uint8Array(), 'OpenAI Images Generations');
    if (parsed.type === 'invalid') {
      return {
        'response.http': jsonResponse(localResponseHead(400), openaiImagesError(parsed.message)),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }
    return await scope.next({
      ...facts,
      'request.openaiImagesGenerations': { ...parsed.body, model: parsed.model } as OpenAIImagesGenerationsPayload,
    });
  },
});
