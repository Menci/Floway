import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import { withUsageNormalized } from './normalize-usage.ts';
import { withVendorDeepseekChatCompletionsNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorKimiChatCompletionsNormalize } from './vendor-kimi-normalize.ts';
import { withVendorQwenChatCompletionsNormalize } from './vendor-qwen-normalize.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';

// Target-side Chat Completions interceptors. Every entry is attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
//   - withUsageStreamOptionsIncluded, withUsageNormalized: unconditional.
//     Both gate the gateway's usage-tracking pipeline. Turning either off
//     would silently break per-key telemetry, so neither is surfaced as a flag.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`. Emits the gateway's canonical
//     "no reasoning" sentinel only; vendor wire form is the vendor's job.
//   - withVendor*ChatCompletionsNormalize: gated by `vendor-<X>`. Registered
//     LAST so that on the outbound path each gets the final say on the wire
//     body and on the inbound path each gets the first say on the upstream
//     stream — the generic interceptors above only see OpenAI-canonical form.
//     Vendor flags are mutually exclusive in practice, but the interceptors
//     are independent and run in declared order if more than one is somehow
//     enabled.
export const chatCompletionsBaseInterceptors: readonly ChatCompletionsInterceptor[] = [
  withUsageStreamOptionsIncluded,
  withUsageNormalized,
  withReasoningDisabledOnForcedToolChoice,
  withVendorDeepseekChatCompletionsNormalize,
  withVendorQwenChatCompletionsNormalize,
  withVendorKimiChatCompletionsNormalize,
];
