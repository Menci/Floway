import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { createCustomProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const customProviderModule: ProviderModule = {
  create: createCustomProvider,
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
};

export { assertCustomUpstreamRecord, type CustomAuthStyle, type CustomIngressHeaderRule, type CustomModelsFetch, type CustomUpstreamConfig } from './config.ts';
export { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
export { customPipelines } from './pipelines.ts';
export { createCustomProvider, projectCustomModels, projectCustomDiscoveredModels } from './provider.ts';
export { toCustomUpstreamFacts, type CustomUpstreamConfigFacts, type CustomUpstreamFacts } from './upstream.ts';
