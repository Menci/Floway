import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { prepareJsonModelRequest } from '../../../shared/json-model-request.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIImagesGenerationsError, openAIImagesStreamRequested, type OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';

const { defineStage } = gatewayFactSpace<{}>();

export const openAIImagesGenerationsError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.openaiImagesGenerations': move({ kind: 'error', source: 'local', error: formatOpenAIImagesGenerationsError(status, message) } as const),
});

export const parseOpenAIImagesGenerations = defineStage({
  name: 'openaiImagesGenerations.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiImagesGenerations', 'serve.model', 'request.delivery'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return invalid('OpenAI Images Generations request body must be valid JSON.');
    const request = prepareJsonModelRequest(raw.value, 'OpenAI Images Generations');
    if (request.type === 'invalid') return invalid(request.message);

    return await scope.next({
      ...facts,
      'request.openaiImagesGenerations': move({ ...request.body, model: request.model } as OpenAIImagesGenerationsPayload),
      'request.delivery': move(openAIImagesStreamRequested(request.body.stream) ? { kind: 'sse', includeUsage: true } as const : { kind: 'json' } as const),
      'serve.model': request.model,
    });
  },
});

const invalid = (message: string) => ({
  'response.http': move(jsonResponseBody(responseHead(400), formatOpenAIImagesGenerationsError(400, message))),
});
