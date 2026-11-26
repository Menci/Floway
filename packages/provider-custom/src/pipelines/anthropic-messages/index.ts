import { customOperationPath } from '../../endpoint.ts';
import { anthropicMessagesError, customOperation, jsonBody } from '../dial.ts';
import { decodeAnthropicMessagesCountTokensResult, decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseJsonBody, parseResultResponse, parseSseResponse } from '@floway-dev/provider';

export const anthropicMessages = customOperation('anthropicMessages', {
  auth: 'x-api-key',
  parse: parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, anthropicMessagesError),
  prepare: (payload, modelId, config) => ({
    path: customOperationPath(config, '/messages'),
    ...jsonBody({ ...payload, stream: true, model: modelId }),
  }),
});

export const anthropicMessagesCountTokens = customOperation('anthropicMessagesCountTokens', {
  auth: 'x-api-key',
  parse: parseResultResponse('anthropicMessagesCountTokens', bytes => {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeAnthropicMessagesCountTokensResult(parsed.value) : parsed;
  }, anthropicMessagesError),
  prepare: (payload, modelId, config) => ({
    path: `${customOperationPath(config, '/messages')}/count_tokens`,
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
