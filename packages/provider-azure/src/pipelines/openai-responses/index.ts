import { azureOpenAIUrl, azureOperation, jsonBody, openAIError } from '../dial.ts';
import { fillEmptyCompactNamespaceDescriptions } from './fill-empty-compact-namespace-descriptions.ts';
import { fillEmptyNamespaceDescriptions } from './fill-empty-namespace-descriptions.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { decodeOpenAIResponsesCompactionResult, decodeOpenAIResponsesStream, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { parseJsonBody, parseResultResponse, parseSseResponse } from '@floway-dev/provider';

export const openaiResponses = azureOperation('openaiResponses', {
  stages: [normalizeDeepSeek, normalizeQwen, fillEmptyNamespaceDescriptions],
  parse: parseSseResponse('openaiResponses', decodeOpenAIResponsesStream, openAIError),
  prepare: (payload, modelId, endpoint) => ({
    url: azureOpenAIUrl(endpoint, '/responses'),
    ...jsonBody({ ...payload, stream: true, model: modelId }),
  }),
});

export const openaiResponsesCompact = azureOperation('openaiResponsesCompact', {
  stages: [fillEmptyCompactNamespaceDescriptions],
  parse: parseResultResponse('openaiResponsesCompact', bytes => {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeOpenAIResponsesCompactionResult(parsed.value) : parsed;
  }, openAIError),
  prepare: (payload, modelId, endpoint) => ({
    url: azureOpenAIUrl(endpoint, '/responses/compact'),
    ...jsonBody({ ...toCompactPayloadShape(payload), model: modelId }),
  }),
});
