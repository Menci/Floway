import { openaiInternalErrorPayload } from '../../shared/openai-errors.ts';
import { clientFrame } from '../pipeline/encode.ts';
import { chatHttpPanicPresentation } from '../pipeline/http-panic.ts';
import { sseFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/upstream';

const internalError = (error: unknown) => openaiInternalErrorPayload(toInternalDebugError(error));

export const openAIChatCompletionsHttpPanicPresentation = chatHttpPanicPresentation(502, internalError, error => {
  const event = internalError(error);
  return clientFrame(event, sseFrame(JSON.stringify(event)));
});
