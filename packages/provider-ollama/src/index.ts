import { assertOllamaUpstreamRecord } from './config.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { createOllamaProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const ollamaProviderModule: ProviderModule = {
  create: createOllamaProvider,
  modelCatalogIdentity: record => assertOllamaUpstreamRecord(record).config,
  modelRequestIdentity: record => assertOllamaUpstreamRecord(record).config,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
};

export { createOllamaProvider } from './provider.ts';
export { assertOllamaUpstreamRecord, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
