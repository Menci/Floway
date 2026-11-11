import { openaiChatCompletionsErrorFromIR } from './events.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

/**
 * States a failed request in the Chat Completions envelope.
 *
 * The same wording the stream uses, so a client sees one shape whether the
 * upstream failed before the stream opened or during it. The upstream's status
 * stands, because the failure it reports is the same one whatever envelope
 * carries it — flattening a `402` to `500` would lose what the client needs to
 * decide whether to retry.
 *
 * A body that is not an error envelope this package recognizes is left alone.
 */
export const restateOpenAIChatCompletionsError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  return restateError(upstreamStatus, headers, { error: openaiChatCompletionsErrorFromIR(error) });
};
