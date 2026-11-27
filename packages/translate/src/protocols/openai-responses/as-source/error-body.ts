import { openaiResponsesErrorEventOf } from './error.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

export const writeOpenAIResponsesError = (upstreamStatus: number, headers: Headers, error: IRErrorPayload) =>
  restateError(upstreamStatus, headers, openaiResponsesErrorEventOf(error));

/**
 * Before a response resource exists, render recognized failures as Responses error events.
 * Preserve upstream status and unrecognized bodies.
 */
export const restateOpenAIResponsesError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  return error === undefined ? undefined : writeOpenAIResponsesError(upstreamStatus, headers, error);
};
