// Qwen wire-dialect normalizer for OpenAI Chat Completions. Always-attached;
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

import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { providerModelOf } from '@floway-dev/provider';

export const withVendorQwenOpenAIChatCompletionsNormalize: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('vendor-qwen')) return await run();

  if (ctx.payload.reasoning_effort === 'none') {
    const { reasoning_effort: _stripped, ...rest } = ctx.payload;
    ctx.payload = { ...rest, enable_thinking: false } as OpenAIChatCompletionsPayload;
  }

  return await run();
};
