import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import { withVendorDeepseekResponsesNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

// Target-side Responses interceptors. Every entry is attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
//   - withCyberPolicyRetried: gated by `retry-cyber-policy`.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`. Emits the gateway's canonical
//     "no reasoning" sentinel only; vendor wire form is the vendor's job.
//   - withVendor*ResponsesNormalize: gated by `vendor-<X>`. Registered LAST
//     so each gets the final say on the outbound wire body — the generic
//     interceptors above only see OpenAI-canonical form. Vendor flags are
//     mutually exclusive in practice, but the interceptors are independent
//     and run in declared order if more than one is somehow enabled.
export const responsesBaseInterceptors: readonly ResponsesInterceptor[] = [
  withCyberPolicyRetried,
  withReasoningDisabledOnForcedToolChoice,
  withVendorDeepseekResponsesNormalize,
  withVendorQwenResponsesNormalize,
];
