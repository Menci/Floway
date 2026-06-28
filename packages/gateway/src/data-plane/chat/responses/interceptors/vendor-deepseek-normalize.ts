// DeepSeek wire-dialect normalizer for the Responses protocol. Always-
// attached; flag-gated by `vendor-deepseek`. Runs last among interceptors
// so it has the final say on the outbound wire body.
//
// Outbound (request → upstream):
//
// - `reasoning.effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel (produced when a Messages source had `thinking: { type:
//   'disabled' }`, etc.). DeepSeek uses a top-level
//   `thinking: { type: 'disabled' }` field instead. We strip the entire
//   `reasoning` object and emit the DeepSeek form.
//
// Inbound: nothing today — the Responses-target dialect quirks that exist
// on Chat (assistant `reasoning_content` field, `prompt_cache_*_tokens`
// usage) have no Responses-shape equivalent that has surfaced. Add hooks
// here if vendor-specific Responses inbound rewrites become necessary.
//
// Reference:
// - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

interface DeepseekDisableField {
  thinking?: { type: 'disabled' };
}

type ResponsesPayloadWithDeepseekDisable = Omit<ResponsesPayload, 'reasoning'> & DeepseekDisableField;

const stripCanonicalReasoningSentinel = (payload: ResponsesPayload): ResponsesPayload => {
  if (payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _stripped, ...rest } = payload;
  const out: ResponsesPayloadWithDeepseekDisable = { ...rest, thinking: { type: 'disabled' } };
  return out as ResponsesPayload;
};

export const withVendorDeepseekResponsesNormalize: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!ctx.candidate.model.enabledFlags.has('vendor-deepseek')) return await run();

  ctx.payload = stripCanonicalReasoningSentinel(ctx.payload);

  return await run();
};
