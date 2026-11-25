import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { createOllamaProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const ollamaProviderModule: ProviderModule = {
  create: createOllamaProvider,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
};

export { createOllamaProvider, getOllamaProvidedModels } from './provider.ts';
export { assertOllamaUpstreamRecord, parseOllamaUpstreamConfig, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
export { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
export { ollamaPipelines } from './pipelines/index.ts';
export { pricingForOllamaModelKey } from './pricing.ts';
export { createOllamaService, type OllamaService, type OllamaServices } from './service.ts';
export { readOllamaUpstreamState, type OllamaAccountEntry, type OllamaUpstreamState } from './state.ts';
export { ollamaUpstreamFact } from './upstream.ts';
export { isOllamaUsageEnabled, refreshOllamaUsageProbe, runOllamaScheduledTask } from './usage-probe.ts';
export { fetchOllamaAccount, refreshOllamaAccount } from './account-probe.ts';

export { ollamaMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from './upstream-metrics.ts';

export { readOllamaAccountUsage, type OllamaAccountUsage, type OllamaUsageData } from './account-usage.ts';
