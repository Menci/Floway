import { geminiGenerateContentErrorFromIR } from './sse-to.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { RestateSourceError } from '../../../types.ts';

/**
 * States a failed request in the GenerateContent envelope.
 *
 * The upstream's own status is the failure that actually happened, and the
 * envelope states it in both places the protocol requires. A body that is not
 * an error envelope this package recognizes is left alone.
 */
export const restateGeminiGenerateContentError: RestateSourceError = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  if (error === undefined) return undefined;
  return restateError(upstream, { error: geminiGenerateContentErrorFromIR(error, upstream.status) });
};
