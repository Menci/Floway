import type { AnthropicMessagesErrorEventEx } from './index.ts';

// https://platform.claude.com/docs/en/api/errors#error-shapes
export const formatAnthropicMessagesError = (
  _status: number | null,
  message: string,
  fields?: Partial<Omit<AnthropicMessagesErrorEventEx['error'], 'message'>>,
): AnthropicMessagesErrorEventEx => ({ type: 'error', error: { type: 'api_error', message, ...fields } });
