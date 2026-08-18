// DeepSeek wire-dialect normalizer for the OpenAI Responses protocol. Always-
// attached; flag-gated by `vendor-deepseek`. Runs last among interceptors
// so it has the final say on the outbound wire body.
//
// Outbound (request → upstream):
//
// - `reasoning.effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel (produced when an Anthropic Messages source had `thinking: { type:
//   'disabled' }`, etc.). DeepSeek uses a top-level
//   `thinking: { type: 'disabled' }` field instead. We strip the entire
//   `reasoning` object and emit the DeepSeek form.
//
// Inbound: nothing today — the OpenAI-Responses-target dialect quirks that exist
// on OpenAI Chat Completions (assistant `reasoning_content` field, `prompt_cache_*_tokens`
// usage) have no OpenAI-Responses-shape equivalent that has surfaced. Add hooks
// here if vendor-specific OpenAI Responses inbound rewrites become necessary.
//
// Reference:
// - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

import type { OpenAIResponsesInterceptor } from './types.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

interface DeepSeekDisableField {
  thinking?: { type: 'disabled' };
}

type CanonicalOpenAIResponsesPayloadWithDeepSeekDisable = Omit<CanonicalOpenAIResponsesPayload, 'reasoning'> & DeepSeekDisableField;

const stripCanonicalReasoningSentinel = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  if (payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _stripped, ...rest } = payload;
  const out: CanonicalOpenAIResponsesPayloadWithDeepSeekDisable = { ...rest, thinking: { type: 'disabled' } };
  return out as CanonicalOpenAIResponsesPayload;
};

export const withVendorDeepSeekOpenAIResponsesNormalize: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('vendor-deepseek')) return await run();

  ctx.payload = stripCanonicalReasoningSentinel(ctx.payload);

  return await run();
};
