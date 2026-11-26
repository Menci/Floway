import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { createCustomProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const customProviderModule: ProviderModule = {
  create: createCustomProvider,
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
};

export { assertCustomUpstreamRecord, validateCustomManualModels, type CustomAuthStyle, type CustomIngressHeaderRule, type CustomModelsFetch, type CustomUpstreamConfig } from './config.ts';
export { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
export { projectCustomDiscoveredModels, projectCustomManualModels, projectCustomModels, projectCustomModelsFromDiscovered } from './provider.ts';
