import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { createAzureProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const azureProviderModule: ProviderModule = {
  create: createAzureProvider,
  defaultFlags: AZURE_DEFAULT_FLAGS,
};
export { assertAzureUpstreamRecord, type AzureUpstreamConfig } from './config.ts';
export { AZURE_DEFAULT_FLAGS } from './defaults.ts';
export { azurePipelines } from './pipelines/index.ts';
export { getAzureProvidedModels } from './provider.ts';
export { azureUpstreamFact } from './upstream.ts';
