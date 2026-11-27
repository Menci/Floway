import { applyOpenAIChatCompletionsAliasRules } from './alias-rules.ts';
import { normalizeOpenAIChatCompletionsCachedTokens } from './cached-token-usage.ts';
import { computeOpenAIChatCompletionsUsage } from './compute-usage.ts';
import { normalizeOpenAIChatCompletionsUsageChunks } from './normalize-usage.ts';
import { measureOpenAIChatCompletionsPerformance } from './performance.ts';
import { rewriteOpenAIChatCompletionsRoles } from './role-compatibility.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';

export const openaiChatCompletionsEgressStages = [
  measureOpenAIChatCompletionsPerformance,
  storeUsage,
  computeOpenAIChatCompletionsUsage,
  normalizeOpenAIChatCompletionsUsageChunks,
  normalizeOpenAIChatCompletionsCachedTokens,
  rewriteOpenAIChatCompletionsRoles,
  applyOpenAIChatCompletionsAliasRules,
] as const;
