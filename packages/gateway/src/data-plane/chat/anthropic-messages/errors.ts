import { inputErrorFields, type InputErrorDetails } from '../shared/errors.ts';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

// Anthropic's own error envelope. The byte shape matches Anthropic-direct:
// `{type:'error', error:{type, message}, request_id}` with `request_id` at the
// top level — alongside `error`, not nested inside it — and the key order is
// load-bearing for byte-faithfulness.
/** What an Anthropic Messages client is sent when a turn produced no content. The envelope is
 *  Anthropic's own — `type` at the top, the error's own `type` inside, and a `request_id` a
 *  caller quotes back in a support thread — so it is the protocol's shape rather than the
 *  gateway's, and an OpenAI-shaped one would carry none of those fields. */
export const renderAnthropicMessagesError = (status: number, message: string): Record<string, unknown> => ({
  type: 'error',
  error: { type: anthropicErrorTypeForStatus(status), message },
  request_id: generateAnthropicId('req'),
});

/** The type name each status carries in this protocol's envelope. */
const anthropicErrorTypeForStatus = (status: number): string => {
  switch (status) {
  case 400: return 'invalid_request_error';
  case 401: return 'authentication_error';
  case 403: return 'permission_error';
  case 404: return 'not_found_error';
  case 413: return 'request_too_large';
  case 429: return 'rate_limit_error';
  case 529: return 'overloaded_error';
  default: return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
};

/** A gateway fault in this protocol's envelope, with its diagnostics under the
 *  provider-extension field. A stream that fails carries the same object as its `error` event. */
export const internalAnthropicMessagesError = (error: unknown) => {
  const debug = toInternalDebugError(error, 'anthropicMessages');
  return { type: 'error' as const, error: { type: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) } };
};

/** Caller input the selected target cannot carry, naming the field at fault. */
export const anthropicMessagesInputError = (error: InputErrorDetails): Record<string, unknown> => {
  const fields = inputErrorFields(error);
  return {
    type: 'error',
    error: { type: 'invalid_request_error', message: error.message, ...(fields === undefined ? {} : { provider_specific_fields: fields }) },
    request_id: generateAnthropicId('req'),
  };
};
