import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import { createOllamaUpstream } from './upstream.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const ollamaUpstreamModule: UpstreamModule = {
  create: createOllamaUpstream,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
  resolveUpstreamMetricDisplay,
};

export { createOllamaUpstream, projectOllamaManualModels } from './upstream.ts';
export { assertOllamaUpstreamRecord, parseOllamaUpstreamConfig, validateOllamaManualModels, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
export { pricingForOllamaModelKey } from './pricing.ts';
export { readOllamaUpstreamState, type OllamaAccountEntry, type OllamaUpstreamState } from './state.ts';
export { isOllamaUsageEnabled, refreshOllamaUsageProbe } from './usage-probe.ts';
export { fetchOllamaAccount, refreshOllamaAccount } from './account-probe.ts';

export { ollamaMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from './upstream-metrics.ts';

export { readOllamaAccountUsage, type OllamaAccountUsage, type OllamaUsageData } from './account-usage.ts';
