import type { ModelPricing } from '@floway-dev/protocols/common';
import type { ProviderModel } from '@floway-dev/provider';
import { pricingForClaudeCodeModelKey } from '@floway-dev/provider-claude-code';
import { pricingForCodexModelKey } from '@floway-dev/provider-codex';
import { pricingForCopilotPublicModelId } from '@floway-dev/provider-copilot';
import { pricingForOllamaModelKey } from '@floway-dev/provider-ollama';

const officialPricingForModelKey = (modelKey: string): ModelPricing | null =>
  pricingForCodexModelKey(modelKey)
  ?? pricingForClaudeCodeModelKey(modelKey)
  ?? pricingForCopilotPublicModelId(modelKey)
  ?? pricingForOllamaModelKey(modelKey);

export const withReferencePricing = (models: ProviderModel[], enabled: boolean | undefined): ProviderModel[] => {
  if (!enabled) return models;
  return models.map(model => {
    if (model.pricing !== undefined) return model;
    const pricing = officialPricingForModelKey(model.upstreamModelId);
    return pricing === null ? model : { ...model, pricing };
  });
};
