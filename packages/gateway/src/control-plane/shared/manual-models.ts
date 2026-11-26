import type { UpstreamModelConfig } from '@floway-dev/upstream';
import { validateAzureManualModels } from '@floway-dev/upstream-azure';
import { validateCustomManualModels } from '@floway-dev/upstream-custom';
import { validateOllamaManualModels } from '@floway-dev/upstream-ollama';

export type ManualModelsUpstreamKind = 'custom' | 'azure' | 'ollama';

export const validateManualModels = (kind: ManualModelsUpstreamKind, raw: unknown): UpstreamModelConfig[] => {
  switch (kind) {
  case 'azure': return validateAzureManualModels(raw);
  case 'custom': return validateCustomManualModels(raw);
  case 'ollama': return validateOllamaManualModels(raw);
  }
};
