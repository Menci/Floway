import type { ProviderModelFact } from '@floway-dev/provider';

export const decisionTarget = (model: ProviderModelFact) => {
  if (!model.decisionTarget) throw new Error(`Copilot decision model ${model.id} has no outbound target`);
  return model.decisionTarget;
};
