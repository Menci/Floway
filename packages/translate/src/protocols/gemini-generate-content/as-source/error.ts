import type { IRErrorPayload } from '../../../ir/types.ts';
import { errorDetailsOf } from '../../../shared/api-error.ts';
import { isContextExceededError } from '../../../shared/context-window-error.ts';
import { geminiGenerateContentStatusForHttpStatus, type GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';

/**
 * HTTP failures supply an upstream status; streaming failures derive a code from the error kind.
 * Context overflow selects our local 400 code.
 */
export const geminiGenerateContentErrorFromIR = (error: IRErrorPayload, httpStatus?: number): GeminiGenerateContentErrorResponse['error'] => {
  const details = errorDetailsOf(error, ['message']);
  // Preserve unmodeled diagnostic fields in a chosen Struct Any inside details.
  // https://protobuf.dev/reference/protobuf/google.protobuf/#struct
  const extension = details === undefined ? {} : { details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: details }] };
  const kind = error.code ?? error.type;
  const code = httpStatus !== undefined && !isContextExceededError(error) ? httpStatus
    : kind === 'rate_limit_exceeded' || kind === 'rate_limit_error' ? 429
      : kind === 'invalid_prompt' || kind === 'invalid_request_error' || isContextExceededError(error) ? 400
        : kind === 'overloaded_error' ? 503 : 500;
  return { code, status: geminiGenerateContentStatusForHttpStatus(code) ?? 'UNKNOWN', message: error.message, ...extension };
};
