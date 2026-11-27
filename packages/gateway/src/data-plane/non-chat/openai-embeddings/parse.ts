import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, localHead, openAIError, readJsonModel } from '../shared/http.ts';

export const parseOpenAIEmbeddings = defineStage({
  name: 'openaiEmbeddings.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiEmbeddings'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const parsed = readJsonModel(facts.http, 'OpenAI Embeddings');
    if (!parsed.ok) {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(parsed.error)) };
    }
    const { model, body } = parsed.value;
    scope.services.dump?.requestedModel(model);
    return await scope.next({ ...facts, openaiEmbeddings: { ...body, model } });
  },
});
