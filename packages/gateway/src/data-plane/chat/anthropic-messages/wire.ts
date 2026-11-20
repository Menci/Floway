import { applyRoleCompatibilityToAnthropicMessages } from './apply-role-compatibility.ts';
import { callAnthropicMessagesUpstream } from './call-upstream.ts';
import { disableReasoningOnForcedToolChoiceForAnthropicMessages } from './disable-reasoning-on-forced-tool-choice.ts';
import { meterUsage } from './meter.ts';
import { normalizeEmptyToolsForAnthropicMessages } from './normalize-empty-tools-tool-choice.ts';
import { stripBillingAttributionFromAnthropicMessages } from './strip-billing-attribution.ts';
import type { Stage } from '@floway-dev/pipeline';

/**
 * The Anthropic Messages wire, as the chain that dials it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs this, whether the
 * client spoke Anthropic Messages or a handoff arrived here — which is what makes a rule that
 * speaks about *this* wire belong here. The system-role rewrite states what an upstream's Anthropic Messages
 * endpoint accepts, so it applies to whatever body this wire actually sends and to nothing
 * that leaves for another protocol.
 *
 * The meter is above every one of them, which is what makes the figure it bills the one the
 * client is shown.
 */
export const anthropicMessagesWire = (streamedUsage: string): readonly Stage[] => [
  normalizeEmptyToolsForAnthropicMessages,
  meterUsage(streamedUsage),
  stripBillingAttributionFromAnthropicMessages,
  disableReasoningOnForcedToolChoiceForAnthropicMessages,
  applyRoleCompatibilityToAnthropicMessages,
  callAnthropicMessagesUpstream,
];
