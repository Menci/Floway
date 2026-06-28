import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import { withUsageNormalized } from './normalize-usage.ts';
import type { ChatCompletionsInterceptor } from './types.ts';
import { withVendorDeepseekChatCompletionsNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorKimiChatCompletionsNormalize } from './vendor-kimi-normalize.ts';
import { withVendorQwenChatCompletionsNormalize } from './vendor-qwen-normalize.ts';

// Unified Chat Completions interceptor list. All entries are attached to
// every candidate; each interceptor's body decides whether to act (flag-gated
// entries early-return on `ctx.candidate.model.enabledFlags.has(flagId)`).
//
// Order follows source-then-target semantics collapsed into a single chain.
//
//   - withUsageStreamOptionsIncluded, withUsageNormalized: unconditional.
//     Both gate the gateway's usage-tracking pipeline. Turning either off
//     would silently break per-key telemetry, so neither is surfaced as a flag.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`. Emits the gateway's canonical
//     "no reasoning" sentinel only; vendor wire form is the vendor's job.
//   - withDemoteDeveloperToSystem: gated by `demote-developer-to-system`.
//     Runs before withInterleavedSystemDemotedToUser so when both flags are
//     on, a `developer` role first lands as `system`, then any system that
//     ends up after the leading run is rewritten to `user` — the chain
//     `developer → system → user` covers the strictest upstreams.
//   - withInterleavedSystemDemotedToUser: gated by
//     `demote-interleaved-system-to-user`. Rewrites any `role: 'system'` that
//     appears after the leading contiguous system run to `role: 'user'` so
//     upstreams that reject mid-stream system messages still accept the body.
//   - withVendor*ChatCompletionsNormalize: gated by `vendor-<X>`. Registered
//     LAST so that on the outbound path each gets the final say on the wire
//     body and on the inbound path each gets the first say on the upstream
//     stream — the generic interceptors above only see OpenAI-canonical form.
//     Vendor flags are mutually exclusive in practice, but the interceptors
//     are independent and run in declared order if more than one is somehow
//     enabled.
export const chatCompletionsInterceptors: readonly ChatCompletionsInterceptor[] = [
  withUsageStreamOptionsIncluded,
  withUsageNormalized,
  withReasoningDisabledOnForcedToolChoice,
  withDemoteDeveloperToSystem,
  withInterleavedSystemDemotedToUser,
  withVendorDeepseekChatCompletionsNormalize,
  withVendorQwenChatCompletionsNormalize,
  withVendorKimiChatCompletionsNormalize,
];
