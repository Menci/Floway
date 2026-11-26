import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { prepareJsonModelRequest } from '../shared/json-model-request.ts';

export const openaiCompletionsError = (message: string) => ({ error: { message, type: 'api_error' } });

export const parseOpenAICompletions = defineStage({
  name: 'openaiCompletions.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const { body } = facts['request.http'];
    const parsed = prepareJsonModelRequest(body ?? new Uint8Array(), 'OpenAI Completions');
    if (parsed.type === 'invalid') {
      return {
        'response.http': jsonResponse(localResponseHead(400), openaiCompletionsError(parsed.message)),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }
    return await scope.next({
      ...facts,
      'request.openaiCompletions': { ...parsed.body, model: parsed.model },
    });
  },
});
