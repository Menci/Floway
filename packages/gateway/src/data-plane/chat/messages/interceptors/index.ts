import { demoteInterleavedSystemToUser } from './demote-interleaved-system-to-user.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor } from './types.ts';
import { withMessagesWebSearchShim } from './web-search-shim.ts';

// Unified Messages interceptor list. All entries are attached to every
// candidate; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.candidate.model.enabledFlags.has(flagId)`).
//
// Order follows source-then-target semantics collapsed into a single chain:
//   - withMessagesWebSearchShim: registered first so its replay rewrite and
//     intercept loop wrap the rest of the chain. Unconditional for translated
//     targets (Responses / Chat Completions cannot carry Anthropic server
//     tools); gated by `messages-web-search-shim` for native Messages targets.
//   - stripBillingAttribution: gated by `strip-billing-attribution` (default
//     on for copilot/azure/custom, off for claude-code). On candidates
//     where it runs, it scrubs Claude Code's `x-anthropic-billing-header` /
//     `cch=` markers out of the source-shape system prompt so prompt-cache
//     hits survive across requests; on claude-code, the block is left intact
//     because Anthropic uses it for plan-tier billing.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - demoteInterleavedSystemToUser: gated by
//     `demote-interleaved-system-to-user`. Anthropic's top-level
//     `payload.system` is conceptually the first-position system slot, so
//     every inline `role: 'system'` message in `payload.messages` is by
//     definition interleaved and gets rewritten to `role: 'user'`.
export const messagesInterceptors: readonly MessagesInterceptor[] = [
  withMessagesWebSearchShim,
  stripBillingAttribution,
  withReasoningDisabledOnForcedToolChoice,
  demoteInterleavedSystemToUser,
];

// The shipped Messages interceptors all inspect post-`run()` event streams,
// which the non-streaming count_tokens path cannot supply — so the list
// stays empty today. Kept as a separate readonly array so the count-tokens
// attempt has a clear extension point.
export const messagesCountTokensInterceptors: readonly MessagesCountTokensInterceptor[] = [];
