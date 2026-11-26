import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createKimiCodeUpstream } from './upstream.ts';
import type { UpstreamModule } from '@floway-dev/upstream';

export const kimiCodeUpstreamModule: UpstreamModule = { create: createKimiCodeUpstream, defaultFlags: KIMI_CODE_DEFAULT_FLAGS };

export { pricingForKimiCodePublicModelId } from './pricing.ts';
export { parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from './config.ts';
export { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
export { refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe } from './probe.ts';
