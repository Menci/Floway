import { geminiGenerateContentErrorFromIR } from './events.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

export const restateGeminiGenerateContentError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  const restated = geminiGenerateContentErrorFromIR(error, upstreamStatus);
  return restateError(restated.code, headers, { error: restated });
};
