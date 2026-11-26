import { azureOpenAIImagesUrl } from '../../endpoint.ts';
import { azureOperation, jsonBody, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';
import { parseHttpResponse } from '@floway-dev/provider';

export const openaiImagesGenerations = azureOperation('openaiImagesGenerations', {
  parse: parseHttpResponse('openaiImagesGenerations', {
    select: payload => payload.stream === true ? 'stream' : 'result',
    stream: decodeOpenAIImagesGenerationsStream,
    result: parseJsonObject,
    format: openAIError,
  }),
  prepare: (payload, modelId, endpoint) => ({
    url: azureOpenAIImagesUrl(endpoint, '/images/generations'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
