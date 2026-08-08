import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { createOllamaProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const ollamaProviderModule: ProviderModule = {
  create: createOllamaProvider,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
};

export { createOllamaProvider } from './provider.ts';
export { assertOllamaUpstreamRecord, parseOllamaUpstreamConfig, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
export { pricingForOllamaModelKey } from './pricing.ts';
export { readOllamaUpstreamState, type OllamaUpstreamState } from './state.ts';
export { fetchOllamaUsageProbe, isOllamaUsageEnabled, refreshOllamaUsageProbe } from './usage-probe.ts';
