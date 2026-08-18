import { answerClaudeCodeProbe } from './answer-claude-code-probe.ts';
import { withRoleCompatibilityApplied } from './apply-role-compatibility.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import type { AnthropicMessagesCountTokensInterceptor, AnthropicMessagesInterceptor, AnthropicMessagesPayloadInterceptor } from './types.ts';
import { withAnthropicMessagesWebSearchRequestPrepared, withAnthropicMessagesWebSearchShim } from './web-search-shim.ts';

// Unified Anthropic Messages generation chain. All entries are attached to every
// candidate; each interceptor decides whether to act — from the candidate's
// model flags and selected target, or, for the client-compatibility entry,
// from the inbound request itself.
//
// Translated requests re-enter the selected target protocol's chain. The role
// compatibility entry therefore acts only when Anthropic Messages is the final target.
//
//   - answerClaudeCodeProbe: registered ahead of everything else because it
//     replaces the turn rather than shaping it — no payload transform below it
//     can matter to a turn that never dials. Unconditional: whether a request
//     is one of Claude Code's one-token probes is a property of the request,
//     not of the candidate.
//   - withAnthropicMessagesWebSearchShim: registered next so its request preparation,
//     replay rewrite, and intercept loop wrap the rest of the generation chain.
//     Unconditional for translated targets (OpenAI Responses / OpenAI Chat Completions cannot
//     carry Anthropic server tools); gated by `messages-web-search-shim` for
//     native Anthropic Messages targets. count_tokens runs the same request preparation
//     without the stream-response wrapper.
//   - stripBillingAttribution: gated by `strip-billing-attribution` (default
//     on for copilot/azure/custom, off for claude-code). On candidates
//     where it runs, it scrubs Claude Code's `x-anthropic-billing-header` /
//     `cch=` markers out of the source-shape system prompt so prompt-cache
//     hits survive across requests; on claude-code, the block is left intact
//     because Anthropic uses it for plan-tier billing.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - withRoleCompatibilityApplied: Anthropic's top-level `payload.system` is
//     the only first-position system slot, so the mid-conversation-system flag
//     rewrites every inline system message to user after Anthropic Messages is selected
//     as the final target.
//
// The remaining three entries mutate only the request payload and are shared
// with count_tokens in the same order. Token counting therefore observes the
// same gateway-level billing-attribution, reasoning, and role shape as
// generation.
const anthropicMessagesPayloadInterceptors: readonly AnthropicMessagesPayloadInterceptor[] = [
  stripBillingAttribution,
  withReasoningDisabledOnForcedToolChoice,
  withRoleCompatibilityApplied,
];

export const anthropicMessagesInterceptors: readonly AnthropicMessagesInterceptor[] = [
  answerClaudeCodeProbe,
  withAnthropicMessagesWebSearchShim,
  ...anthropicMessagesPayloadInterceptors,
];

export const anthropicMessagesCountTokensInterceptors: readonly AnthropicMessagesCountTokensInterceptor[] = [
  withAnthropicMessagesWebSearchRequestPrepared,
  ...anthropicMessagesPayloadInterceptors,
];
