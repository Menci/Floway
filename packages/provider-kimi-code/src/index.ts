import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createKimiCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const kimiCodeProviderModule: ProviderModule = { create: createKimiCodeProvider, defaultFlags: KIMI_CODE_DEFAULT_FLAGS };

export { createKimiCodeProvider } from './provider.ts';
export { pricingForKimiCodePublicModelId } from './pricing.ts';
export { parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from './config.ts';
export { readKimiCodeUpstreamState, type KimiCodeAccount, type KimiCodeObservation, type KimiCodeProbeEntry, type KimiCodeUpstreamState } from './state.ts';
export { refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe } from './probe.ts';
export { readKimiCodeUsage, type KimiCodeUsageData, type KimiCodeQuotaWindow, type KimiCodeAccountUsage } from './usage.ts';
export { kimiCodeMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from './upstream-metrics.ts';
