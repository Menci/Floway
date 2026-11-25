import type { FormatProtocolError } from '@floway-dev/provider';

export const formatOpenAIError: FormatProtocolError = (status, message) => ({
  error: {
    type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error',
    code: null,
    param: null,
    message,
  },
});

export const formatAnthropicMessagesError: FormatProtocolError = (status, message) => ({
  type: 'error',
  error: {
    type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error',
    message,
  },
});
