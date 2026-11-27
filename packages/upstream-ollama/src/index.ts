import { getOllamaModels } from './catalog.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { runOllamaScheduledTask } from './usage-probe.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const ollamaUpstreamModule = {
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
  getModels: getOllamaModels,
  runScheduledTask: runOllamaScheduledTask,
} satisfies UpstreamModule;

export { projectOllamaManualModels } from './catalog.ts';
export { assertOllamaUpstreamRecord, parseOllamaUpstreamConfig, validateOllamaManualModels, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
export { pricingForOllamaModelKey } from './pricing.ts';
export { readOllamaUpstreamState, type OllamaAccountEntry, type OllamaUpstreamState } from './state.ts';
export { isOllamaUsageEnabled, refreshOllamaUsageProbe } from './usage-probe.ts';
export { fetchOllamaAccount, refreshOllamaAccount } from './account-probe.ts';
export { ollamaPipelines } from './pipelines/index.ts';
export { createOllamaActiveUsageService, type OllamaActiveUsageService, type OllamaPipelineServices, type OllamaProbeTarget } from './service.ts';

export { ollamaMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from './upstream-metrics.ts';

export { readOllamaAccountUsage, type OllamaAccountUsage, type OllamaUsageData } from './account-usage.ts';
