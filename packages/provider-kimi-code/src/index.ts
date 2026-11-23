import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createKimiCodeProvider } from './provider.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const kimiCodeProviderModule: ProviderModule = {
  create: createKimiCodeProvider,
  defaultFlags: KIMI_CODE_DEFAULT_FLAGS,
  resolveUpstreamMetricDisplay,
};

export { pricingForKimiCodePublicModelId } from './pricing.ts';
export { parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from './config.ts';
export { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
export { refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe } from './probe.ts';
