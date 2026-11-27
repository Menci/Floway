import { openaiChatCompletionsErrorFromIR } from './error.ts';
import type { IRErrorPayload } from '../../../ir/output/error.ts';
import { irErrorPayloadFromBody, restateError } from '../../../shared/api-error.ts';
import type { ApiErrorTranslator } from '../../../types.ts';

export const writeOpenAIChatCompletionsError = (upstreamStatus: number, headers: Headers, error: IRErrorPayload) =>
  restateError(upstreamStatus, headers, { error: openaiChatCompletionsErrorFromIR(error) });

/** Reuse the stream error object, preserve upstream HTTP status, and pass unrecognized bodies through unchanged. */
export const restateOpenAIChatCompletionsError: ApiErrorTranslator = (upstreamStatus, headers, upstreamBody) => {
  const error = irErrorPayloadFromBody(upstreamBody);
  return error === undefined ? undefined : writeOpenAIChatCompletionsError(upstreamStatus, headers, error);
};
