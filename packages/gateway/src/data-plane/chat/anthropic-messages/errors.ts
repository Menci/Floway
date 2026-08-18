import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';

// Anthropic's own error envelope. The byte shape matches Anthropic-direct:
// `{type:'error', error:{type, message}, request_id}` with `request_id` at the
// top level — alongside `error`, not nested inside it — and the key order is
// load-bearing for byte-faithfulness.
/** What a Messages client is sent when a turn produced no content. The envelope is
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
