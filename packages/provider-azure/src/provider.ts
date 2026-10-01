import { assertAzureUpstreamRecord } from './config.ts';
import { AZURE_DEFAULT_FLAGS } from './defaults.ts';
import { createAzurePipelines } from './pipelines.ts';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type ProviderInstance, type Provider, type UpstreamRecord } from '@floway-dev/provider';

export const createAzureProvider = (record: UpstreamRecord): Provider => {
  const azure = assertAzureUpstreamRecord(record);

  const instance: ProviderInstance = {
    getProvidedModels() {
      return Promise.resolve(azure.config.models.map(model => {
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
          providerData: { upstreamModelId: model.upstreamModelId },
          enabledFlags: effective,
          opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
        };
      }));
    },
  };

  return {
    upstreamId: azure.id,
    kind: 'azure',
    name: azure.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: azure.disabledPublicModelIds,
    modelPrefix: azure.modelPrefix,
    modelsCache: azure.modelsCache,
    pipelines: createAzurePipelines(azure.config),
    instance,
  };
};
