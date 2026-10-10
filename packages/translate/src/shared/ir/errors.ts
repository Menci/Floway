import type { IRJSONObject } from './ir.ts';
import { isContextExceededError } from '../anthropic-messages-via/context-window-error.ts';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';

export const irMessagesError = (error: IRJSONObject): IRJSONObject => isContextExceededError(error)
  ? { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE }
  : { type: ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error'].includes(error.type as string) ? error.type : 'api_error', message: error.message };

// A failed Responses event has no HTTP status; these are target classifications.
// https://developers.openai.com/api/reference/resources/responses/streaming-events
// https://ai.google.dev/gemini-api/docs/troubleshooting
export const irGenerateContentError = (error: IRJSONObject): IRJSONObject => {
  const code = error.code ?? error.type;
  const [status, statusCode] = code === 'rate_limit_exceeded' || code === 'rate_limit_error' ? ['RESOURCE_EXHAUSTED', 429]
    : code === 'invalid_prompt' || code === 'invalid_request_error' || isContextExceededError(error) ? ['INVALID_ARGUMENT', 400]
      : code === 'overloaded_error' ? ['UNAVAILABLE', 503] : ['INTERNAL', 500];
  return { code: statusCode, status, message: error.message };
};

export const irChatError = (error: IRJSONObject): IRJSONObject => ({
  message: error.message,
  type: typeof error.type === 'string' && error.type !== 'error' ? error.type : error.code ?? 'server_error',
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.param === undefined ? {} : { param: error.param }),
  ...(error.provider_specific_fields === undefined ? {} : { provider_specific_fields: error.provider_specific_fields }),
});
