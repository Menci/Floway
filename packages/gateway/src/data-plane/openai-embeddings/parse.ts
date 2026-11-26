import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { prepareJsonModelRequest } from '../shared/json-model-request.ts';

export const embeddingsError = (message: string) => ({ error: { message, type: 'api_error' } });

export const parseOpenAIEmbeddings = defineStage({
  name: 'openaiEmbeddings.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiEmbeddings'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const body = facts['request.http'].body;
    const parsed = prepareJsonModelRequest(body ?? new Uint8Array(), 'OpenAI Embeddings');
    if (parsed.type === 'invalid') {
      return {
        'response.http': jsonResponse(localResponseHead(400), embeddingsError(parsed.message)),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }
    return await scope.next({
      ...facts,
      'request.openaiEmbeddings': { ...parsed.body, model: parsed.model },
    });
  },
});
