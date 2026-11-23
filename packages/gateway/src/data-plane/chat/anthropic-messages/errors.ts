import { inputErrorFields, type InputErrorDetails } from '../shared/errors.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

export const internalAnthropicMessagesErrorPayload = (cause: unknown) => {
  const error = toInternalDebugError(cause);
  return {
    type: 'error',
    error: {
      type: error.type,
      message: error.message,
      provider_specific_fields: internalDebugErrorFields(error),
    },
  };
};

export const anthropicMessagesErrorBody = (type: string, message: string, extension?: Record<string, unknown>) => ({
  type: 'error',
  error: { type, message, ...(extension === undefined ? {} : { provider_specific_fields: extension }) },
  request_id: generateAnthropicId('req'),
});

export const anthropicMessagesInputErrorBody = (error: InputErrorDetails) =>
  anthropicMessagesErrorBody('invalid_request_error', error.message, inputErrorFields(error));
