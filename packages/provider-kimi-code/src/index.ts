import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createKimiCodeProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const kimiCodeProviderModule: ProviderModule = { create: createKimiCodeProvider, defaultFlags: KIMI_CODE_DEFAULT_FLAGS };

export { pricingForKimiCodePublicModelId } from './pricing.ts';
export {
  parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, toKimiCodeUpstreamFacts,
  type KimiCodeUpstreamConfig, type KimiCodeUpstreamConfigFacts, type KimiCodeUpstreamFacts,
} from './config.ts';
export { kimiCodePipelines } from './pipelines.ts';
export { createKimiCodeService, type KimiCodeService, type KimiCodeServices } from './service.ts';
export { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
export { refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe } from './probe.ts';
