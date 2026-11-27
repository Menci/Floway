import { protocolErrorDebugFields, type FormatProtocolError } from '@floway-dev/upstream';

export const formatOpenAIError: FormatProtocolError = (status, message, diagnostic) => ({
  error: {
    type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error',
    code: null,
    param: null,
    message,
    ...protocolErrorDebugFields(diagnostic),
  },
});

export const formatAnthropicMessagesError: FormatProtocolError = (status, message, diagnostic) => ({
  type: 'error',
  error: {
    type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error',
    message,
    ...protocolErrorDebugFields(diagnostic),
  },
});
