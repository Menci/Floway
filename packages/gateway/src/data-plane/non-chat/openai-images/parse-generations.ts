import { defineStage } from '../../pipeline/facts.ts';
import { jsonResponse, localHead, openAIError, readJsonModel } from '../shared/http.ts';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';

export const parseOpenAIImagesGenerations = defineStage({
  name: 'openaiImagesGenerations.parse',
  through: {
    request: { needs: ['http'], provides: ['openaiImagesGenerations'], consumes: [] },
    response: { needs: ['http'], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute(facts, scope) {
    const parsed = readJsonModel(facts.http, 'OpenAI Images Generations');
    if (!parsed.ok) {
      scope.services.dump?.error('gateway');
      return { http: jsonResponse(localHead(400), openAIError(parsed.error)) };
    }
    const { model, body } = parsed.value;
    scope.services.dump?.requestedModel(model);
    return await scope.next({ ...facts, openaiImagesGenerations: { ...body, model } as OpenAIImagesGenerationsPayload });
  },
});
