import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { createAzureUpstream } from './upstream.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const azureUpstreamModule: UpstreamModule = {
  create: createAzureUpstream,
  defaultFlags: AZURE_DEFAULT_FLAGS,
};
export { assertAzureUpstreamRecord, validateAzureManualModels, type AzureUpstreamConfig } from './config.ts';
export { projectAzureModels } from './upstream.ts';
