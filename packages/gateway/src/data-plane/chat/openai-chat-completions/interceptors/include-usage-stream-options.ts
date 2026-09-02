import type { OpenAIChatCompletionsInterceptor } from './types.ts';

// OpenAI Chat Completions streaming only includes the final usage-only chunk when
// `stream_options.include_usage` is enabled. We force that on here because
// the gateway's source responders and usage tracking rely on those usage
// frames for both streaming passthrough and non-stream reassembly.
//
// The follow-on question is whether to surface the synthesized usage chunk to
// the client. The client's intent is whatever the caller put on
// `stream_options.include_usage` BEFORE this interceptor mutated it; the
// downstream SSE renderer reads that intent directly off the original payload
// the http entry parsed (see `openaiChatCompletionsHttp`), so this interceptor only
// has to flip the upstream-facing flag and never needs to thread the original
// value through a Hono context slot.
//
// Reference: https://platform.openai.com/docs/api-reference/chat/create
export const withUsageStreamOptionsIncluded: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  ctx.payload.stream_options = ctx.payload.stream_options ? { ...ctx.payload.stream_options, include_usage: true } : { include_usage: true };
  return await run();
};
