// Qwen wire-dialect normalizer for the OpenAI Responses protocol. Always-attached;
// flag-gated by `vendor-qwen`. Runs last among interceptors so it has the
// final say on the outbound wire body.
//
// Outbound (request → upstream):
//
// - `reasoning.effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel. Qwen uses a top-level `enable_thinking: false` field instead.
//   We strip the entire `reasoning` object and emit the Qwen form.
//
// Inbound: nothing today.
//
// Reference:
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking

import type { OpenAIResponsesInterceptor } from './types.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

export const withVendorQwenOpenAIResponsesNormalize: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('vendor-qwen')) return await run();

  if (ctx.payload.reasoning?.effort === 'none') {
    const { reasoning: _stripped, ...rest } = ctx.payload;
    ctx.payload = { ...rest, enable_thinking: false } as CanonicalOpenAIResponsesPayload;
  }

  return await run();
};
