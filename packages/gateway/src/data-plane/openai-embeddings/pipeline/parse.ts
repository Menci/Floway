import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { responseHead } from '../../pipeline/response.ts';
import { prepareJsonModelRequest } from '../../shared/json-model-request.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { formatOpenAIEmbeddingsError } from '@floway-dev/protocols/openai-embeddings';

const { defineStage } = gatewayFactSpace<{}>();

export const openAIEmbeddingsError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.openaiEmbeddings': move({ kind: 'error', source: 'local', error: formatOpenAIEmbeddingsError(status, message) } as const),
});

export const parseOpenAIEmbeddings = defineStage({
  name: 'openaiEmbeddings.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiEmbeddings', 'serve.model'], consumes: [] },
    response: { needs: ['response.http', 'response.openaiEmbeddings'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiEmbeddings'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return openAIEmbeddingsError(400, 'OpenAI Embeddings request body must be valid JSON.');

    const request = prepareJsonModelRequest(raw.value, 'OpenAI Embeddings');
    if (request.type === 'invalid') return openAIEmbeddingsError(400, request.message);

    return await scope.next({
      ...facts,
      'request.openaiEmbeddings': move({ ...request.body, model: request.model }),
      'serve.model': request.model,
    });
  },
});
