import { geminiGenerateContentErrorFromIR } from './error.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

export const writeGeminiGenerateContentError = (upstreamStatus: number, headers: Headers, error: IRErrorPayload) => {
  const restated = geminiGenerateContentErrorFromIR(error, upstreamStatus);
  return restateError(restated.code, headers, { error: restated });
};

/**
 * Restate recognized failures as RPC error envelopes using the native error constructor's status.
 * Unrecognized bodies pass through verbatim.
 */
export const restateGeminiGenerateContentError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  return error === undefined ? undefined : writeGeminiGenerateContentError(upstreamStatus, headers, error);
};
