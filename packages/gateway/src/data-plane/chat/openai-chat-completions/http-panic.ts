import { sseHttpPanicPresentation } from '../../shared/http-panic.ts';
import { openaiInternalErrorPayload, openaiInternalErrorSseFrame } from '../../shared/openai-errors.ts';
import { toInternalDebugError } from '@floway-dev/upstream';

export const openAIChatCompletionsHttpPanicPresentation = sseHttpPanicPresentation(
  502,
  error => openaiInternalErrorPayload(toInternalDebugError(error)),
  openaiInternalErrorSseFrame,
);
