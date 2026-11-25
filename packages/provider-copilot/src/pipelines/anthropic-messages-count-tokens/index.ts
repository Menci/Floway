import { compressImages } from '../anthropic-messages/compress-images.ts';
import { normalizeAnthropicBeta } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { setInitiatorHeader } from '../anthropic-messages/set-initiator-header.ts';
import { setVisionHeader } from '../anthropic-messages/set-vision-header.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { dial, jsonRequest } from '../shared/dial.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripAnthropicMessagesClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeAnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal, parseJsonBody, parseResultResponse } from '@floway-dev/provider';

const operation = 'anthropicMessagesCountTokens';

const parse = parseResultResponse(operation, bytes => {
  const parsed = parseJsonBody(bytes);
  return parsed.ok ? decodeAnthropicMessagesCountTokensResult(parsed.value) : parsed;
}, formatAnthropicMessagesError);

export const anthropicMessagesCountTokens = copilotOperation<typeof operation>().compose('copilot.anthropicMessagesCountTokens', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.anthropicMessagesCountTokens'],
  exit: ['response.http', 'response.anthropicMessagesCountTokens'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectModel.anthropicMessagesCountTokens,
    setIdentityHeaders,
    compressImages(operation),
    setVisionHeader(operation),
    setInitiatorHeader(operation),
    normalizeAnthropicBeta(operation),
    parse,
    authorize(operation, formatAnthropicMessagesError),
    dial.anthropicMessagesCountTokens(payload => jsonRequest('/v1/messages/count_tokens', payload), formatAnthropicMessagesError),
    observeQuota,
  ],
  ending: httpTerminal,
});
