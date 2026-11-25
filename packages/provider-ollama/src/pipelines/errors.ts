import type { FormatProtocolError } from '@floway-dev/provider';

const errorType = (status: number | null): string => status === null || status >= 500 ? 'api_error' : 'invalid_request_error';

export const formatOpenAIError: FormatProtocolError = (status, message) => ({ error: { type: errorType(status), message } });
export const formatAnthropicError: FormatProtocolError = (status, message) => ({ type: 'error', error: { type: errorType(status), message } });
