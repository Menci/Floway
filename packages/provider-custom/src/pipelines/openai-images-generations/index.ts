import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';
import { parseHttpResponse } from '@floway-dev/provider';

export const openaiImagesGenerations = customOperation('openaiImagesGenerations', {
  parse: parseHttpResponse('openaiImagesGenerations', {
    select: payload => payload.stream === true ? 'stream' : 'result',
    stream: decodeOpenAIImagesGenerationsStream,
    result: parseJsonObject,
    format: openAIError,
  }),
  prepare: (payload, modelId, config) => ({
    path: customOperationPath(config, '/images/generations'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
