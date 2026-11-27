import { localChatAnswer } from '../pipeline/local-answer.ts';
import { inputErrorFields, type ChatRoutingFailure, type InputErrorDetails } from '../shared/errors.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/upstream';

export const anthropicMessagesDebugError = (cause: unknown, type?: string) => {
  const error = toInternalDebugError(cause);
  return {
    type: 'error',
    error: { type: type ?? error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) },
  };
};

const anthropicError = (
  status: number,
  type: string,
  message: string,
  extension?: Record<string, unknown>,
) => localChatAnswer(status, {
  type: 'error',
  error: { type, message, ...(extension === undefined ? {} : { provider_specific_fields: extension }) },
  request_id: generateAnthropicId('req'),
});

export const anthropicMessagesInputError = (error: InputErrorDetails) =>
  anthropicError(400, 'invalid_request_error', error.message, inputErrorFields(error));

export const anthropicMessagesRoutingError = (failure: ChatRoutingFailure) => {
  switch (failure.kind) {
  case 'routing-unavailable':
    return anthropicError(400, 'invalid_request_error', failure.message);
  case 'model-missing':
    return anthropicError(404, 'not_found_error', `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return anthropicError(400, 'invalid_request_error', `Model ${failure.model} does not support the /messages endpoint.`);
  }
};
