import { anthropicMessagesErrorBody } from './sse-to.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import { isContextExceededError } from '../../../shared/context-window-error.ts';
import type { SourceProtocolErrorWriter } from '../../../types.ts';

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
export const anthropicMessagesErrorWriter: SourceProtocolErrorWriter = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  if (error === undefined) return undefined;
  // The restatement keeps the upstream's status, with one exception: Claude Code
  // recognizes an overflow only as a 400 carrying the prompt-too-long wording,
  // and it is that recognition that makes the client retry with a smaller
  // prompt. Any other status would read as an ordinary failure.
  return restateError(upstream, anthropicMessagesErrorBody(error), isContextExceededError(error) ? 400 : undefined);
};
