import { projectAzureModels } from './catalog.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const azureUpstreamModule: UpstreamModule = {
  defaultFlags: AZURE_DEFAULT_FLAGS,
  async getModels(record, _fetcher, manualModels = []) {
    return projectAzureModels(record, manualModels);
  },
  async runScheduledTask() {},
};
export { assertAzureUpstreamRecord, validateAzureManualModels, type AzureUpstreamConfig } from './config.ts';
export { projectAzureModels };
export * from './pipelines/index.ts';
