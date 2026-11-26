import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { parseResultResponse } from '@floway-dev/provider';

export const openaiEmbeddings = customOperation('openaiEmbeddings', {
  parse: parseResultResponse('openaiEmbeddings', parseJsonObject, openAIError),
  prepare: (payload, modelId, config) => ({
    path: customOperationPath(config, '/embeddings'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
