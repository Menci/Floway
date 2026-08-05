import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { createCustomProvider } from './provider.ts';
import { CUSTOM_INBOUND_HEADER_ALLOWLIST } from './config.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const customProviderModule: ProviderModule = {
  create: createCustomProvider,
  inboundHeaderAllowlist: CUSTOM_INBOUND_HEADER_ALLOWLIST,
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
};

export { assertCustomUpstreamRecord, type CustomIngressHeaderRule, type CustomModelsFetch, type CustomUpstreamConfig } from './config.ts';
export { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
export { projectCustomModels } from './provider.ts';
