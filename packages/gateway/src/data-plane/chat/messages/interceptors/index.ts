import { demoteInterleavedSystemToUser } from './demote-interleaved-system-to-user.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor, MessagesPayloadInterceptor } from './types.ts';
import { withMessagesWebSearchRequestPrepared, withMessagesWebSearchShim } from './web-search-shim.ts';

// Unified Messages generation chain. All entries are attached to every
// candidate; each interceptor decides whether to act from the candidate's
// model flags and selected target.
//
//   - withMessagesWebSearchShim: registered first so its request preparation,
//     replay rewrite, and intercept loop wrap the rest of the generation chain.
//     Unconditional for translated targets (Responses / Chat Completions cannot
//     carry Anthropic server tools); gated by `messages-web-search-shim` for
//     native Messages targets. count_tokens runs the same request preparation
//     without the stream-response wrapper.
//   - stripBillingAttribution: gated by `strip-billing-attribution` (default
//     on for copilot/azure/custom, off for claude-code). On candidates
//     where it runs, it scrubs Claude Code's `x-anthropic-billing-header` /
//     `cch=` markers out of the source-shape system prompt so prompt-cache
//     hits survive across requests; on claude-code, the block is left intact
//     because Anthropic uses it for plan-tier billing.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - demoteInterleavedSystemToUser: Anthropic's top-level `payload.system` is
//     the only first-position system slot, so the interleaved-system flag
//     rewrites every inline system message to user.
//
// The remaining three entries mutate only the request payload and are shared
// with count_tokens in the same order. Token counting therefore observes the
// same gateway-level billing-attribution, reasoning, and role shape as
// generation.
const messagesPayloadInterceptors: readonly MessagesPayloadInterceptor[] = [
  stripBillingAttribution,
  withReasoningDisabledOnForcedToolChoice,
  demoteInterleavedSystemToUser,
];

export const messagesInterceptors: readonly MessagesInterceptor[] = [
  withMessagesWebSearchShim,
  ...messagesPayloadInterceptors,
];

export const messagesCountTokensInterceptors: readonly MessagesCountTokensInterceptor[] = [
  withMessagesWebSearchRequestPrepared,
  ...messagesPayloadInterceptors,
];
