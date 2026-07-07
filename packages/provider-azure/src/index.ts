import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { createAzureProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const azureProvider: ProviderModule = {
  create: createAzureProvider,
  defaultFlags: AZURE_DEFAULT_FLAGS,
};

export { createAzureProvider } from './provider.ts';
export {
  assertAzureUpstreamRecord,
  configuredEndpoints,
} from './config.ts';
