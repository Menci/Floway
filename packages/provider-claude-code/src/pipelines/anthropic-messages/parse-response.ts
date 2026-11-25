import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { parseSseResponse, type FormatProtocolError } from '@floway-dev/provider';

// https://platform.claude.com/docs/en/api/errors
export const formatAnthropicError: FormatProtocolError = (status, message) => ({
  type: 'error',
  error: {
    type: status === 429 ? 'rate_limit_error' : status !== null && status < 500 ? 'invalid_request_error' : 'api_error',
    message,
  },
});

export const parseResponse = parseSseResponse('anthropicMessages', decodeAnthropicMessagesStream, formatAnthropicError);
