import { irErrorPayloadFromBody } from '../../../shared/api-error.ts';
import type { SourceProtocolErrorWriter } from '../../../types.ts';
import { anthropicMessagesErrorBody, anthropicMessagesErrorStatus } from './sse-to.ts';

/**
 * States a failed request in the Messages envelope.
 *
 * The wording and status come from the same functions the stream uses, so a
 * client sees one shape whether the upstream failed before the stream opened or
 * during it.
 */
export const anthropicMessagesErrorWriter: SourceProtocolErrorWriter = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  return {
    status: anthropicMessagesErrorStatus(error),
    headers: new Headers({ 'content-type': 'application/json' }),
    body: anthropicMessagesErrorBody(error),
  };
};
