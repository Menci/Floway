import { geminiGenerateContentErrorFromIR } from './error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

/**
 * Restate recognized failures as RPC error envelopes using the native error constructor's status.
 * Unrecognized bodies pass through verbatim.
 */
export const restateGeminiGenerateContentError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  const restated = geminiGenerateContentErrorFromIR(error, upstreamStatus);
  return restateError(restated.code, headers, { error: restated });
};
