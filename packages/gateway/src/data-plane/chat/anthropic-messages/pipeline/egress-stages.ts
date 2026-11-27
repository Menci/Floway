import { applyAnthropicMessagesAliasRules } from './alias-rules.ts';
import { computeAnthropicMessagesUsage } from './compute-usage.ts';
import { measureAnthropicMessagesPerformance } from './performance.ts';
import { rewriteAnthropicMessagesRoles } from './role-compatibility.ts';
import { storeUsage } from '../../../pipeline/store-usage.ts';

export const anthropicMessagesEgressStages = [
  measureAnthropicMessagesPerformance,
  storeUsage,
  computeAnthropicMessagesUsage,
  rewriteAnthropicMessagesRoles,
  applyAnthropicMessagesAliasRules,
] as const;
