import { openaiResponsesErrorEventOf } from './error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

/**
 * Before a response resource exists, render recognized failures as Responses error events.
 * Preserve upstream status and unrecognized bodies.
 */
export const restateOpenAIResponsesError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  return restateError(upstreamStatus, headers, openaiResponsesErrorEventOf(error));
};
