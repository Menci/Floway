import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { createAzureProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const azureProviderModule: ProviderModule = {
  create: createAzureProvider,
  defaultFlags: AZURE_DEFAULT_FLAGS,
};
export { assertAzureUpstreamRecord, type AzureUpstreamConfig } from './config.ts';
