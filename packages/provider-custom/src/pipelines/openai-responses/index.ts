import { customOperationPath } from '../../endpoint.ts';
import { customOperation, jsonBody, openAIError } from '../dial.ts';
import { normalizeDeepSeek } from './vendor-deepseek-normalize.ts';
import { normalizeQwen } from './vendor-qwen-normalize.ts';
import { decodeOpenAIResponsesCompactionResult, decodeOpenAIResponsesStream, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { parseJsonBody, parseResultResponse, parseSseResponse } from '@floway-dev/provider';

export const openaiResponses = customOperation('openaiResponses', {
  stages: [normalizeDeepSeek, normalizeQwen],
  parse: parseSseResponse('openaiResponses', decodeOpenAIResponsesStream, openAIError),
  prepare: (payload, model, config) => ({
    path: customOperationPath(config, '/responses'),
    ...jsonBody({ ...payload, stream: true, model: model.upstreamModelId }),
  }),
});

export const openaiResponsesCompact = customOperation('openaiResponsesCompact', {
  parse: parseResultResponse('openaiResponsesCompact', bytes => {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeOpenAIResponsesCompactionResult(parsed.value) : parsed;
  }, openAIError),
  prepare: (payload, model, config) => ({
    path: `${customOperationPath(config, '/responses')}/compact`,
    ...jsonBody({ ...toCompactPayloadShape(payload), model: model.upstreamModelId }),
  }),
});
