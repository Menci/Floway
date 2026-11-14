import { prepareAnthropicMessagesWebSearchRequest } from './prepare-web-search.ts';
import { applyRoleCompatibilityToAnthropicMessages } from '../apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoiceForAnthropicMessages } from '../disable-reasoning-on-forced-tool-choice.ts';
import { stripBillingAttributionFromAnthropicMessages } from '../strip-billing-attribution.ts';
import { callAnthropicMessagesCountTokensUpstream } from './call-upstream.ts';
import type { Stage } from '@floway-dev/pipeline';

/**
 * The Anthropic Messages count-tokens wire, as the chain that dials it.
 *
 * Every source protocol whose measurement reaches an upstream does it over this endpoint —
 * Gemini's `:countTokens` has no wire of its own and arrives here through a translation — so
 * a rule that speaks about *this* wire belongs here rather than beside a source's own
 * strippers. All four do: the system-role rewrite and the reasoning sentinel state what an
 * upstream's Anthropic Messages endpoint accepts, the billing-attribution scrub states what generation
 * would have sent it, and the web-search preparation states the tool shape it would have
 * seen.
 */
export const anthropicMessagesCountTokensWire: readonly Stage[] = [
  prepareAnthropicMessagesWebSearchRequest,
  stripBillingAttributionFromAnthropicMessages,
  disableReasoningOnForcedToolChoiceForAnthropicMessages,
  applyRoleCompatibilityToAnthropicMessages,
  callAnthropicMessagesCountTokensUpstream,
];
