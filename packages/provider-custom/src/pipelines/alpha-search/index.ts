import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { parseResultResponse } from '@floway-dev/provider';

export const alphaSearch = customOperation('alphaSearch', {
  parse: parseResultResponse('alphaSearch', bytes => ({ ok: true, value: bytes }), openAIError),
  prepare: (payload, modelId, config) => ({
    path: customOperationPath(config, '/alpha/search'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
