import { formatAnthropicError } from '../errors.ts';
import { decodeAnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { parseJsonBody, parseResultResponse } from '@floway-dev/provider';

export const parseResponse = parseResultResponse('anthropicMessagesCountTokens', bytes => {
  const parsed = parseJsonBody(bytes);
  return parsed.ok ? decodeAnthropicMessagesCountTokensResult(parsed.value) : parsed;
}, formatAnthropicError);
