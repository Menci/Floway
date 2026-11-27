import { assertKimiCodeUpstreamRecord } from './config.ts';
import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { fetchKimiCodeModels } from './models.ts';
import { runKimiCodeScheduledTask } from './probe.ts';
import { resolveEffectiveFlags, type Fetcher, type UpstreamModule, type UpstreamRecord } from '@floway-dev/upstream';

export const kimiCodeUpstreamModule = {
  defaultFlags: KIMI_CODE_DEFAULT_FLAGS,
  getModels: (record: UpstreamRecord, fetcher: Fetcher) => fetchKimiCodeModels(
    assertKimiCodeUpstreamRecord(record).config,
    fetcher,
    resolveEffectiveFlags([KIMI_CODE_DEFAULT_FLAGS, record.flagOverrides]),
  ),
  runScheduledTask: runKimiCodeScheduledTask,
} satisfies UpstreamModule;

export { pricingForKimiCodePublicModelId } from './pricing.ts';
export { kimiCodePipelines } from './pipelines/index.ts';
export type { KimiCodePipelineServices } from './pipelines/facts.ts';
export { parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from './config.ts';
export { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
export { createKimiCodeService, refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe, type KimiCodeService } from './probe.ts';
