import { anthropicMessagesError, azureAnthropicMessagesUrl, azureOperation, jsonBody } from '../dial.ts';
import { decodeAnthropicMessagesCountTokensResult, decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseJsonBody, parseResultResponse, parseSseResponse } from '@floway-dev/provider';

export const anthropicMessages = azureOperation('anthropicMessages', {
  surface: 'anthropicMessages',
  parse: parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, anthropicMessagesError),
  prepare: (payload, modelId, endpoint) => ({
    url: azureAnthropicMessagesUrl(endpoint, '/v1/messages'),
    ...jsonBody({ ...payload, stream: true, model: modelId }),
  }),
});

export const anthropicMessagesCountTokens = azureOperation('anthropicMessagesCountTokens', {
  surface: 'anthropicMessages',
  parse: parseResultResponse('anthropicMessagesCountTokens', bytes => {
    const parsed = parseJsonBody(bytes);
    return parsed.ok ? decodeAnthropicMessagesCountTokensResult(parsed.value) : parsed;
  }, anthropicMessagesError),
  prepare: (payload, modelId, endpoint) => ({
    url: azureAnthropicMessagesUrl(endpoint, '/v1/messages/count_tokens'),
    ...jsonBody({ ...payload, model: modelId }),
  }),
});
