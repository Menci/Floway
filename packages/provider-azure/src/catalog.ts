import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

export const projectAzureModels = (record: UpstreamRecord): ProviderModel[] => {
  const azure = assertAzureUpstreamRecord(record);
  return azure.config.models.map(model => {
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    return {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      ...(model.display_name !== undefined && { display_name: model.display_name }),
      ...(model.pricing !== undefined && { pricing: model.pricing }),
      ...(kind === 'chat' && model.chat !== undefined && { chat: model.chat }),
      kind,
      endpoints,
      providerData: { upstreamModelId: model.upstreamModelId },
      enabledFlags: resolveEffectiveFlags([AZURE_DEFAULT_FLAGS, azure.flagOverrides, model.flagOverrides]),
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      // Foundry decision deployments speak System One.
      // https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision
      ...(kind === 'decision' && { decisionTarget: { protocol: 'typesafe-systemone' as const } }),
    };
  });
};
