import { assertKimiCodeUpstreamRecord } from './config.ts';
import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { fetchKimiCodeModels } from './models.ts';
import { createKimiCodePipelines } from './pipelines.ts';
import { runKimiCodeScheduledTask } from './probe.ts';
import { resolveEffectiveFlags, type Provider, type UpstreamRecord } from '@floway-dev/provider';

export const createKimiCodeProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertKimiCodeUpstreamRecord(record);
  const enabledFlags = resolveEffectiveFlags([KIMI_CODE_DEFAULT_FLAGS, record.flagOverrides]);
  return {
    upstreamId: record.id,
    kind: 'kimi-code',
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    pipelines: createKimiCodePipelines(record, config),
    instance: {
      getProvidedModels: fetcher => fetchKimiCodeModels(config, fetcher, enabledFlags),
      runScheduledTask: options => runKimiCodeScheduledTask(record, options),
    },
  };
};
