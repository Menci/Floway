import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { responseHead } from '../../../pipeline/response.ts';
import { prepareJsonModelRequest } from '../../../shared/json-model-request.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIImagesGenerationsError, type OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';

const { defineStage } = gatewayFactSpace<{}>();

export const openAIImagesGenerationsError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.openaiImagesGenerations': move({ kind: 'error', source: 'local', error: formatOpenAIImagesGenerationsError(status, message) } as const),
});

export const parseOpenAIImagesGenerations = defineStage({
  name: 'openaiImagesGenerations.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiImagesGenerations', 'serve.model'], consumes: [] },
    response: { needs: ['response.http', 'response.openaiImagesGenerations'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiImagesGenerations'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return openAIImagesGenerationsError(400, 'OpenAI Images Generations request body must be valid JSON.');
    const request = prepareJsonModelRequest(raw.value, 'OpenAI Images Generations');
    if (request.type === 'invalid') return openAIImagesGenerationsError(400, request.message);

    return await scope.next({
      ...facts,
      'request.openaiImagesGenerations': move({ ...request.body, model: request.model } as OpenAIImagesGenerationsPayload),
      'serve.model': request.model,
    });
  },
});
