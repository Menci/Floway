// Qwen wire-dialect normalizer for Chat Completions. Always-attached;
// flag-gated by `vendor-qwen`. Runs last among target interceptors so it
// has the final say on the outbound wire body.
//
// Outbound (request → upstream):
//
// - `reasoning_effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel. Qwen doesn't accept 'none' in its `reasoning_effort` enum and
//   instead uses a top-level `enable_thinking: false` field. We strip the
//   sentinel and emit the Qwen form.
//
// Inbound: nothing today — Qwen's response shape already matches OpenAI's
// for the fields the gateway reads. Add hooks here if vendor-specific
// inbound rewrites surface.
//
// Reference:
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking

import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

interface QwenDisableField {
  enable_thinking?: false;
}

type ChatCompletionsPayloadWithQwenDisable = Omit<ChatCompletionsPayload, 'reasoning_effort'> & QwenDisableField;

const stripCanonicalReasoningSentinel = (payload: ChatCompletionsPayload): ChatCompletionsPayload => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _stripped, ...rest } = payload;
  const out: ChatCompletionsPayloadWithQwenDisable = { ...rest, enable_thinking: false };
  return out as ChatCompletionsPayload;
};

export const withVendorQwenChatCompletionsNormalize: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('vendor-qwen')) return await run();

  ctx.payload = stripCanonicalReasoningSentinel(ctx.payload);

  return await run();
};
