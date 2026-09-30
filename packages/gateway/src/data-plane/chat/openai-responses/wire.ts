import { applyRoleCompatibilityToOpenAIResponses } from './apply-role-compatibility.ts';
import { callOpenAIResponsesUpstream } from './call-upstream.ts';
import { disableReasoningOnForcedToolChoiceForOpenAIResponses } from './disable-reasoning-on-forced-tool-choice.ts';
import { meterUsage } from './meter.ts';
import { normalizeAssistantContentForOpenAIResponses } from './normalize-assistant-content.ts';
import { normalizeEmptyToolsForOpenAIResponses } from './normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokensForOpenAIResponses } from './normalize-exclusive-cached-tokens.ts';
import { stripPromptCacheKeyForOpenAIResponses } from './strip-prompt-cache-key.ts';
import { vendorDeepSeekNormalizeForOpenAIResponses } from './vendor-deep-seek-normalize.ts';
import { vendorQwenNormalizeForOpenAIResponses } from './vendor-qwen-normalize.ts';
import type { Stage } from '@floway-dev/pipeline';

/**
 * What every turn this wire sends is subject to, whichever operation asked for it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs these, whether the
 * client spoke OpenAI Responses or a handoff arrived here — which is what makes the three rules
 * belong to the wire. The role rewrite and the assistant-content rewrite both state what an
 * upstream's OpenAI Responses endpoint accepts; the cache-bucket fold speaks about the usage *this*
 * wire reports and about the flag that describes it, and a translator emits the canonical
 * form, which is the one case the fold has nothing to do with.
 *
 * They are named apart from the dial because a compaction is dialled differently and is
 * subject to the same three.
 */
export const openaiResponsesWireRules: readonly Stage[] = [
  normalizeEmptyToolsForOpenAIResponses,
  normalizeAssistantContentForOpenAIResponses,
  disableReasoningOnForcedToolChoiceForOpenAIResponses,
  applyRoleCompatibilityToOpenAIResponses,
  stripPromptCacheKeyForOpenAIResponses,
  normalizeExclusiveCachedTokensForOpenAIResponses,
  vendorDeepSeekNormalizeForOpenAIResponses,
  vendorQwenNormalizeForOpenAIResponses,
];

/** The OpenAI Responses wire, as the chain that dials it. The meter is above every rule, which
 *  is what makes the figure it bills the one the client is shown. */
export const openaiResponsesWire = (streamedUsage: string): readonly Stage[] => [
  meterUsage(streamedUsage),
  ...openaiResponsesWireRules,
  callOpenAIResponsesUpstream,
];
