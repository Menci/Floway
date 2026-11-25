import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createKimiCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const kimiCodeProviderModule: ProviderModule = { create: createKimiCodeProvider, defaultFlags: KIMI_CODE_DEFAULT_FLAGS };

export { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
export { getKimiCodeProvidedModels } from './models.ts';
export { kimiCodePipelines } from './pipelines/index.ts';
export { createKimiCodeService, type KimiCodeService, type KimiCodeServices } from './service.ts';
export { kimiCodeUpstreamFact } from './upstream-fact.ts';
export { pricingForKimiCodePublicModelId } from './pricing.ts';
export { parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from './config.ts';
export { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
export { refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe, runKimiCodeScheduledTask } from './probe.ts';
