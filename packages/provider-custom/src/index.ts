import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { createCustomProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const customProvider: ProviderModule = {
  create: createCustomProvider,
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
};

export { createCustomProvider } from './provider.ts';
export { assertCustomUpstreamRecord } from './config.ts';
export { fetchCustomModels } from './fetch-models.ts';
