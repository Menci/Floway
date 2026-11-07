import { irErrorPayloadFromBody } from '../../../shared/api-error.ts';
import type { SourceProtocolErrorWriter } from '../../../types.ts';
import { irGenerateContentError } from './sse-to.ts';

/**
 * States a failed request in the GenerateContent envelope.
 *
 * The same wording and status the stream uses, so a client sees one shape
 * whether the upstream failed before the stream opened or during it.
 */
export const geminiGenerateContentErrorWriter: SourceProtocolErrorWriter = upstream => {
  const body = irGenerateContentError(irErrorPayloadFromBody(upstream));
  return {
    status: body.code,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify({ error: body })),
  };
};
