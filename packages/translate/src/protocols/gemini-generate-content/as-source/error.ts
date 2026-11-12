import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { errorDetailsOf } from '../../../shared/api-error.ts';
import { isContextExceededError } from '../../../shared/context-window-error.ts';
import type { GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';

/**
 * Use the Google RPC status vocabulary for the numeric error code.
 * https://ai.google.dev/api/rest/v1beta/Status
 */
const statusNameOf = (status: number): string => {
  switch (status) {
  case 400: return 'INVALID_ARGUMENT';
  case 401: return 'UNAUTHENTICATED';
  case 403: return 'PERMISSION_DENIED';
  case 404: return 'NOT_FOUND';
  case 408: return 'DEADLINE_EXCEEDED';
  case 409: return 'ABORTED';
  case 429: return 'RESOURCE_EXHAUSTED';
  case 500: return 'INTERNAL';
  case 501: return 'UNIMPLEMENTED';
  case 503: return 'UNAVAILABLE';
  case 504: return 'DEADLINE_EXCEEDED';
  default: return 'UNKNOWN';
  }
};

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
  return { code, status: statusNameOf(code), message: error.message, ...extension };
};
