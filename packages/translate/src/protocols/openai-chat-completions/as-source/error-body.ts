import { openaiChatCompletionsErrorFromIR } from './error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

/** Reuse the stream error object, preserve upstream HTTP status, and pass unrecognized bodies through unchanged. */
export const restateOpenAIChatCompletionsError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  if (error === undefined) return undefined;
  return restateError(upstreamStatus, headers, { error: openaiChatCompletionsErrorFromIR(error) });
};
