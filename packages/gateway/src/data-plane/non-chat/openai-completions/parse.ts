import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, localHead, openAIError, readJsonModel } from '../shared/http.ts';

export const parseOpenAICompletions = defineStage({
  name: 'openaiCompletions.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiCompletions'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const parsed = readJsonModel(facts.http, 'OpenAI Completions');
    if (!parsed.ok) {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(parsed.error)) };
    }
    const { model, body } = parsed.value;
    scope.services.dump?.requestedModel(model);
    return await scope.next({ ...facts, openaiCompletions: { ...body, model } });
  },
});
