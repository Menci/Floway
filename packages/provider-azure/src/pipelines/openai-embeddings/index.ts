import { azureOpenAIUrl, azureOperation, jsonBody, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { parseResultResponse } from '@floway-dev/provider';

export const openaiEmbeddings = azureOperation('openaiEmbeddings', {
  parse: parseResultResponse('openaiEmbeddings', parseJsonObject, openAIError),
  prepare: (payload, modelId, endpoint) => ({
    url: azureOpenAIUrl(endpoint, '/embeddings'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
