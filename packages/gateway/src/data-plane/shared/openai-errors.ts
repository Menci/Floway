import { sseHttpPanicPresentation } from './http-panic.ts';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';
import { type InternalDebugError, internalDebugErrorFields, toInternalDebugError } from '@floway-dev/upstream';

// The SDK throws on a top-level error object, including in unnamed SSE data.
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L56-L73
export const openaiInternalErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

export const openaiInternalErrorSseFrame = (cause: unknown) => {
  const payload = openaiInternalErrorPayload(toInternalDebugError(cause));
  return { frame: eventFrame(payload), wire: sseFrame(JSON.stringify(payload)) };
};

export const openaiNonChatHttpPanicPresentation = sseHttpPanicPresentation(
  502,
  error => ({ error: toInternalDebugError(error) }),
  openaiInternalErrorSseFrame,
);
