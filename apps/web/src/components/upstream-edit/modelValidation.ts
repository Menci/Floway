import type { UpstreamModelConfig } from '../../api/types.ts';
import { collectModelPricingIssues } from '@floway-dev/protocols/common';

export const isModelConfigValid = (config: UpstreamModelConfig): boolean => {
  if (config.pricing !== undefined && collectModelPricingIssues(config.pricing).length > 0) return false;

  const reasoning = config.chat?.reasoning;
  if (reasoning === undefined) return true;
  if (reasoning.effort !== undefined) {
    if (reasoning.effort.supported.length === 0) return false;
    if (reasoning.effort.default === '' || !reasoning.effort.supported.includes(reasoning.effort.default)) return false;
  }
  const budget = reasoning.budget_tokens;
  return budget?.min === undefined || budget.max === undefined || budget.max >= budget.min;
};
