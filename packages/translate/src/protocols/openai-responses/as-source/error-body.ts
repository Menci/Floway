import { openaiResponsesErrorEventOf } from './sse-to.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { RestateSourceError } from '../../../types.ts';

/**
 * States a failed request in the Responses envelope.
 *
 * A failure before the stream opens has no `response` object to hang the error
 * on, so it is stated as the same `error` event the stream would have carried.
 * The upstream's status stands, since the envelope is the only thing the client
 * speaks differently.
 *
 * A body that is not an error envelope this package recognizes is left alone.
 */
export const restateOpenAIResponsesError: RestateSourceError = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  if (error === undefined) return undefined;
  return restateError(upstream, openaiResponsesErrorEventOf(error));
};
