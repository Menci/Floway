import { irErrorPayloadFromBody } from '../../../shared/api-error.ts';
import type { IRErrorPayload } from '../../../ir/common/error.ts';
import type { SourceProtocolErrorWriter } from '../../../types.ts';

/** The status Responses reports for each error code it states. */
const statusOf = (error: IRErrorPayload): number => {
  switch (error.code ?? error.type) {
  case 'invalid_request_error': return 400;
  case 'authentication_error': return 401;
  case 'permission_error': return 403;
  case 'not_found_error': return 404;
  case 'rate_limit_exceeded': return 429;
  default: return 500;
  }
};

/**
 * States a failed request in the Responses envelope.
 *
 * A failure before the stream opens has no `response` object to hang the error
 * on, so it is stated as the same `error` event the stream would have carried.
 */
export const openaiResponsesErrorWriter: SourceProtocolErrorWriter = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  return {
    status: statusOf(error),
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify({
      type: 'error',
      message: error.message,
      code: error.code ?? error.type ?? null,
      param: error.param ?? null,
    })),
  };
};
