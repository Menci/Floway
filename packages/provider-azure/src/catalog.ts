import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

export const getAzureProvidedModels = (record: UpstreamRecord): Promise<ProviderModel[]> => {
  const azure = assertAzureUpstreamRecord(record);
  return Promise.resolve(azure.config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([AZURE_DEFAULT_FLAGS, azure.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    return {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
      ...(model.pricing ? { pricing: model.pricing } : {}),
      ...(kind === 'chat' && model.chat ? { chat: model.chat } : {}),
      kind,
      endpoints,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      ...(kind === 'decision' ? { decisionTarget: { protocol: 'typesafe-systemone' as const } } : {}),
    };
  }));
};
