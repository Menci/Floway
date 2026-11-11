import { anthropicMessagesErrorEnvelope } from './events.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

/**
 * States a failed request in the Messages envelope.
 *
 * The wording comes from the same function the stream uses, so a client sees
 * one shape whether the upstream failed before the stream opened or during it.
 *
 * A body that is not an error envelope this package recognizes is left alone:
 * restating an unknown shape would describe the failure wrongly, and the
 * upstream's own answer is the more faithful one.
 */
export const restateAnthropicMessagesError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  // The restatement keeps the upstream's status with one exception, which the
  // shared statement decides alongside the wording so the two cannot drift.
  const { body, status } = anthropicMessagesErrorEnvelope(error);
  return restateError(status ?? upstreamStatus, headers, body);
};
