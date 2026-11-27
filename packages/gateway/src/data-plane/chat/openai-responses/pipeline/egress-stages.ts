import { applyOpenAIResponsesAliasRules } from './alias-rules.ts';
import { normalizeOpenAIResponsesCachedTokens } from './cached-token-usage.ts';
import { computeOpenAIResponsesUsage } from './compute-usage.ts';
import { measureOpenAIResponsesPerformance } from './performance.ts';
import { stripOpenAIResponsesPromptCacheKey } from './prompt-cache-key.ts';
import { applyOpenAIResponsesRoleCompatibility } from './role-compatibility.ts';
import { forceOpenAIResponsesStoreFalse } from './store-false.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';

export const openaiResponsesEgressStages = [
  measureOpenAIResponsesPerformance,
  storeUsage,
  computeOpenAIResponsesUsage,
  applyOpenAIResponsesRoleCompatibility,
  stripOpenAIResponsesPromptCacheKey,
  forceOpenAIResponsesStoreFalse,
  normalizeOpenAIResponsesCachedTokens,
  applyOpenAIResponsesAliasRules,
] as const;
