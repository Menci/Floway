import type { GatewayCtx } from './gateway-ctx.ts';
import { serializeSseFrame } from './sse.ts';
import { eventFrame, isJsonObject, sseFrame } from '@floway-dev/protocols/common';
import { type InternalDebugError, internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

export const openaiInternalErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    message: error.message,
    provider_specific_fields: internalDebugErrorFields(error),
  },
});

export const isOpenAIErrorPayload = (value: unknown): boolean =>
  isJsonObject(value) && isJsonObject(value.error) && typeof value.error.message === 'string';

// The SDK throws on a top-level error object, including in unnamed SSE data.
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L56-L73
export const openaiSseFailure = async (ctx: GatewayCtx, error: unknown) => {
  const event = openaiInternalErrorPayload(toInternalDebugError(error));
  await ctx.dump?.frame(eventFrame(event));
  return [serializeSseFrame(sseFrame(JSON.stringify(event)))] as const;
};
