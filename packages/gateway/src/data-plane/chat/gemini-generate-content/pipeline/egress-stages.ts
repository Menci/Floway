import { applyGeminiGenerateContentAliasRules } from './alias-rules.ts';
import { computeGeminiGenerateContentUsage } from './compute-usage.ts';
import { measureGeminiGenerateContentPerformance } from './performance.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';

export const geminiGenerateContentEgressStages = [
  measureGeminiGenerateContentPerformance,
  storeUsage,
  computeGeminiGenerateContentUsage,
  applyGeminiGenerateContentAliasRules,
] as const;
