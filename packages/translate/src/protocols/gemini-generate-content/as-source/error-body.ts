import { irGenerateContentError } from './sse-to.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { SourceProtocolErrorWriter } from '../../../types.ts';

/**
 * States a failed request in the GenerateContent envelope.
 *
 * The upstream's own status is the failure that actually happened, and the
 * envelope states it in both places the protocol requires. A body that is not
 * an error envelope this package recognizes is left alone.
 */
export const geminiGenerateContentErrorWriter: SourceProtocolErrorWriter = upstream => {
  const error = irErrorPayloadFromBody(upstream);
  if (error === undefined) return undefined;
  const body = irGenerateContentError(error, upstream.status);
  return restateError(upstream, new TextEncoder().encode(JSON.stringify({ error: body })));
};
