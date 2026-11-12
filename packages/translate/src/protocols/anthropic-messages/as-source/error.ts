import type { IRErrorPayload } from '../../../ir/types.ts';
import { errorDetailsOf } from '../../../shared/api-error.ts';
import { isContextExceededError } from '../../../shared/context-window-error.ts';
import { PROMPT_TOO_LONG_MESSAGE, type AnthropicMessagesErrorEventEx } from '@floway-dev/protocols/anthropic-messages';

// https://platform.claude.com/docs/en/api/errors#http-errors
const MESSAGES_ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
];

const messagesError = (error: IRErrorPayload, contextExceeded: boolean): AnthropicMessagesErrorEventEx['error'] => {
  const type = contextExceeded
    ? 'invalid_request_error'
    : error.type !== undefined && MESSAGES_ERROR_TYPES.includes(error.type) ? error.type : 'api_error';
  const details = errorDetailsOf(error, type === error.type ? ['message', 'type'] : ['message']);
  const extension = details === undefined ? {} : { provider_specific_fields: details };
  return { type, message: contextExceeded ? PROMPT_TOO_LONG_MESSAGE : error.message, ...extension };
};

export const anthropicMessagesErrorFromIR = (error: IRErrorPayload): AnthropicMessagesErrorEventEx['error'] =>
  messagesError(error, isContextExceededError(error));

export const anthropicMessagesErrorEnvelope = (error: IRErrorPayload): { readonly body: unknown; readonly status: number | undefined } => {
  const contextExceeded = isContextExceededError(error);
  return {
    body: { type: 'error', error: messagesError(error, contextExceeded) },
    status: contextExceeded ? 400 : undefined,
  };
};
