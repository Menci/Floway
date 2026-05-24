// Qwen wire-dialect normalizer for the Responses target. Always-attached;
// flag-gated by `vendor-qwen`. Runs last among target interceptors so it
// has the final say on the outbound wire body.
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

import type { ResponsesInterceptor } from '../../../interceptors.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

interface QwenDisableField {
  enable_thinking?: false;
}

type ResponsesPayloadWithQwenDisable = Omit<ResponsesPayload, 'reasoning'> & QwenDisableField;

const stripCanonicalReasoningSentinel = (payload: ResponsesPayload): ResponsesPayload => {
  if (payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _stripped, ...rest } = payload;
  const out: ResponsesPayloadWithQwenDisable = { ...rest, enable_thinking: false };
  return out as ResponsesPayload;
};

export const withVendorQwenResponsesNormalize: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!ctx.enabledFlags.has('vendor-qwen')) return await run();

  ctx.payload = stripCanonicalReasoningSentinel(ctx.payload);

  return await run();
};
