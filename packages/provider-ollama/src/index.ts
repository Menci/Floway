import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { createOllamaProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const ollamaProvider: ProviderModule = {
  create: createOllamaProvider,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
};

export { createOllamaProvider } from './provider.ts';
export { assertOllamaUpstreamRecord, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
