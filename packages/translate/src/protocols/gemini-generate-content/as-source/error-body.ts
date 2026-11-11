import { geminiGenerateContentErrorFromIR } from './events.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

/**
 * States a failed request in the GenerateContent envelope.
 *
 * The upstream's own status is the failure that actually happened, and the
 * envelope states it in both places the protocol requires. A body that is not
 * an error envelope this package recognizes is left alone.
 */
export const restateGeminiGenerateContentError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  return restateError(upstreamStatus, headers, { error: geminiGenerateContentErrorFromIR(error, upstreamStatus) });
};
