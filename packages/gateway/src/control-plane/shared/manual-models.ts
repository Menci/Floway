import type { UpstreamModelConfig } from '@floway-dev/provider';
import { validateAzureManualModels } from '@floway-dev/provider-azure';
import { validateCustomManualModels } from '@floway-dev/provider-custom';
import { validateOllamaManualModels } from '@floway-dev/provider-ollama';

export type ManualModelsProviderKind = 'custom' | 'azure' | 'ollama';

export const validateManualModels = (kind: ManualModelsProviderKind, raw: unknown): UpstreamModelConfig[] => {
  switch (kind) {
  case 'azure': return validateAzureManualModels(raw);
  case 'custom': return validateCustomManualModels(raw);
  case 'ollama': return validateOllamaManualModels(raw);
  }
};
