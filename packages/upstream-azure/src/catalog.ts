import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';

// https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision
const DECISION_PROTOCOL = 'typesafe-systemone';

export const projectAzureModels = (
  record: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
): UpstreamModel[] => {
  const azure = assertAzureUpstreamRecord(record);
  return manualModels.map(model => {
    const effective = resolveEffectiveFlags([AZURE_DEFAULT_FLAGS, azure.flagOverrides, model.flagOverrides]);
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
      upstreamData: { upstreamModelId: model.upstreamModelId },
      enabledFlags: effective,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      ...(kind === 'decision' ? { decisionTarget: { protocol: DECISION_PROTOCOL } } : {}),
    };
  });
};
