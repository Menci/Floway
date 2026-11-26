import { dial } from './dial.ts';
import { selectModel } from './select-model.ts';
import { compressImages } from '../anthropic-messages/compress-images.ts';
import { normalizeAnthropicBeta } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { setInitiatorHeader } from '../anthropic-messages/set-initiator-header.ts';
import { setVisionHeader } from '../anthropic-messages/set-vision-header.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripAnthropicMessagesClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeAnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';
import { httpTerminal, parseJsonBody, parseResultResponse } from '@floway-dev/provider';

const operation = 'anthropicMessagesCountTokens';

const parse = parseResultResponse(operation, {
  needs: [],
  noContent: null,
  format: formatAnthropicMessagesError,
  decode(bytes) {
    const parsed = parseJsonBody(bytes);
    if (!parsed.ok) return parsed;
    const body = parsed.value;
    // Copilot's translated count reports total_tokens on the Anthropic endpoint.
    // https://github.com/Menci/Floway/blob/844908d7813c92b59e836e5b4cec772a156e53c4/packages/gateway/src/data-plane/chat/gemini-generate-content/attempt.ts#L94-L99
    if (isJsonObject(body) && !Object.hasOwn(body, 'input_tokens')) {
      const { total_tokens: total, ...fields } = body;
      if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) {
        return decodeAnthropicMessagesCountTokensResult({ ...fields, input_tokens: total });
      }
    }
    return decodeAnthropicMessagesCountTokensResult(body);
  },
});

export const anthropicMessagesCountTokens = copilotOperation<typeof operation>().compose('copilot.anthropicMessagesCountTokens', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.anthropicMessagesCountTokens'],
  exit: ['response.http', 'response.anthropicMessagesCountTokens', 'response.usageModelKey?'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectModel,
    setIdentityHeaders,
    compressImages(operation),
    setVisionHeader(operation),
    setInitiatorHeader(operation),
    normalizeAnthropicBeta(operation),
    parse,
    authorize(operation, formatAnthropicMessagesError),
    dial,
    observeQuota,
  ],
  ending: httpTerminal,
});
