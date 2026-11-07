import { irErrorPayloadFromBody } from '../../../shared/api-error.ts';
import type { IRErrorPayload } from '../../../ir/common/error.ts';
import type { SourceProtocolErrorWriter } from '../../../types.ts';
import { irChatError } from './sse-to.ts';

/** The status Chat reports for each error type it states. */
const statusOf = (error: IRErrorPayload): number => {
  switch (irChatError(error).type) {
  case 'invalid_request_error': return 400;
  case 'authentication_error': return 401;
  case 'insufficient_quota':
  case 'rate_limit_exceeded': return 429;
  default: return 500;
  }
};

/**
 * States a failed request in the Chat Completions envelope.
 *
 * The same wording the stream uses, so a client sees one shape whether the
 * upstream failed before the stream opened or during it.
 */
export const openaiChatCompletionsErrorWriter: SourceProtocolErrorWriter = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  return {
    status: statusOf(error),
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify({ error: irChatError(error) })),
  };
};
