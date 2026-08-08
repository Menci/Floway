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
export { assertOllamaUpstreamState, emptyOllamaUpstreamState, readOllamaUpstreamState, type OllamaUsageObservation, type OllamaUsageProbeEntry, type OllamaUpstreamState } from './state.ts';
export { fetchOllamaUsageProbe, isOllamaCloudConfig, refreshOllamaUsageProbe, OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS } from './usage-probe.ts';
