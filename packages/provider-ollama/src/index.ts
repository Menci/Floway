import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { createOllamaProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const ollamaProviderModule: ProviderModule = {
  create: createOllamaProvider,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
};

export { createOllamaProvider } from './provider.ts';
export { assertOllamaUpstreamRecord, parseOllamaUpstreamConfig, toOllamaUpstreamFacts, type OllamaUpstreamConfig, type OllamaUpstreamConfigFacts, type OllamaUpstreamFacts, type OllamaUpstreamRecord } from './config.ts';
export { ollamaPipelines } from './pipelines.ts';
export { createOllamaService, type OllamaService, type OllamaServices } from './service.ts';
export { pricingForOllamaModelKey } from './pricing.ts';
export { readOllamaUpstreamState, type OllamaAccountEntry, type OllamaUpstreamState } from './state.ts';
export { isOllamaUsageEnabled, refreshOllamaUsageProbe } from './usage-probe.ts';
export { fetchOllamaAccount, refreshOllamaAccount } from './account-probe.ts';

export { ollamaMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from './upstream-metrics.ts';

export { readOllamaAccountUsage, type OllamaAccountUsage, type OllamaUsageData } from './account-usage.ts';
