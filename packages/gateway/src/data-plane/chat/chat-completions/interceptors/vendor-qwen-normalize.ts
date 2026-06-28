// Qwen wire-dialect normalizer for Chat Completions. Always-attached;
// flag-gated by `vendor-qwen`. Runs last among the gateway's interceptors so
// it has the final say on the outbound wire body.
//
// Outbound (request → upstream):
//
// - `reasoning_effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel. Qwen doesn't accept 'none' in its `reasoning_effort` enum and
//   instead uses a top-level `enable_thinking: false` field. We strip the
//   sentinel and emit the Qwen form.
//
// Inbound: Qwen's response shape matches OpenAI for the fields the gateway reads.
//
// Reference:
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking

import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

export const withVendorQwenChatCompletionsNormalize: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('vendor-qwen')) return await run();

  if (ctx.payload.reasoning_effort === 'none') {
    const { reasoning_effort: _stripped, ...rest } = ctx.payload;
    ctx.payload = { ...rest, enable_thinking: false } as ChatCompletionsPayload;
  }

  return await run();
};
