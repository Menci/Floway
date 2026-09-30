import { applyRoleCompatibilityToOpenAIChatCompletions } from './apply-role-compatibility.ts';
import { callOpenAIChatCompletionsUpstream } from './call-upstream.ts';
import { disableReasoningOnForcedToolChoiceForOpenAIChatCompletions } from './disable-reasoning-on-forced-tool-choice.ts';
import { includeUsageStreamOptionsForOpenAIChatCompletions } from './include-usage-stream-options.ts';
import { meterUsage } from './meter.ts';
import { normalizeEmptyToolsForOpenAIChatCompletions } from './normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokensForOpenAIChatCompletions } from './normalize-exclusive-cached-tokens.ts';
import { normalizeUsageForOpenAIChatCompletions } from './normalize-usage.ts';
import { stripPromptCacheKeyForOpenAIChatCompletions } from './strip-prompt-cache-key.ts';
import { vendorDeepSeekNormalizeForOpenAIChatCompletions } from './vendor-deep-seek-normalize.ts';
import { vendorKimiNormalizeForOpenAIChatCompletions } from './vendor-kimi-normalize.ts';
import { vendorQwenNormalizeForOpenAIChatCompletions } from './vendor-qwen-normalize.ts';
import type { Stage } from '@floway-dev/pipeline';

/**
 * The OpenAI Chat Completions wire, as the chain that dials it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs this, whether the
 * client spoke OpenAI Chat Completions or a handoff arrived here — which is what makes a rule that
 * speaks about *this* wire belong here. The role rewrite states what an upstream's Chat
 * Completions endpoint accepts; the usage rules speak about the usage this wire asks for and
 * this wire reports; the vendor dialects are how one upstream spells both. All of them apply
 * to whatever body this wire actually sends and to nothing that leaves for another protocol.
 *
 * The order is the one the rules had as an onion, which is the same order in both directions:
 * a stage earlier in the array rewrites the request first and reads the answer last. So the
 * usage chunk is asked for above everything, and coming back the vendor dialects have the
 * first say — the generic rules above them then read a body already in OpenAI-canonical form,
 * with the cache-bucket fold seeing cache fields under OpenAI's names and the carrier split
 * seeing usage the fold has already settled. The meter is above all of them, which is what
 * makes the figure it bills the one the client is shown.
 *
 * `disableReasoningOnForcedToolChoice` and `stripPromptCacheKey` are here rather than above
 * the fork, because both speak about what an upstream's OpenAI Chat Completions endpoint accepts —
 * so a turn that arrived over a translation gets them too. Both still precede every vendor
 * dialect on the request path: the canonical sentinel is emitted before a vendor spells it,
 * and the field an upstream would reject is gone before a vendor rewrites what is left.
 */
export const openaiChatCompletionsWire = (streamedUsage: string): readonly Stage[] => [
  normalizeEmptyToolsForOpenAIChatCompletions,
  meterUsage(streamedUsage),
  includeUsageStreamOptionsForOpenAIChatCompletions,
  normalizeUsageForOpenAIChatCompletions,
  disableReasoningOnForcedToolChoiceForOpenAIChatCompletions,
  applyRoleCompatibilityToOpenAIChatCompletions,
  stripPromptCacheKeyForOpenAIChatCompletions,
  normalizeExclusiveCachedTokensForOpenAIChatCompletions,
  vendorDeepSeekNormalizeForOpenAIChatCompletions,
  vendorQwenNormalizeForOpenAIChatCompletions,
  vendorKimiNormalizeForOpenAIChatCompletions,
  callOpenAIChatCompletionsUpstream,
];
