import type { RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import { type ModelCandidate, providerModelOf, toProviderModelFacts } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

export const routeCandidate = (candidate: ModelCandidate): RouteCandidate => {
  const { provider, model } = candidate;
  const providerModel = toProviderModelFacts(providerModelOf(candidate));
  return {
    upstreamId: provider.upstreamId, upstreamName: provider.name, kind: provider.kind,
    modelId: model.id, upstreamModelId: providerModel.upstreamModelId, endpoints: model.endpoints, limits: model.limits, providerModel,
    ...(candidate.rules === undefined ? {} : { rules: candidate.rules }),
  };
};

export const affinityCandidate = (
  upstreamId: string, modelId = 'model-a',
  scope: { bindToUpstream: boolean; key?: string } = { bindToUpstream: true },
): RouteCandidate => {
  const base = stubModelCandidate();
  return routeCandidate(stubModelCandidate({
    provider: { ...base.provider, upstreamId },
    model: {
      id: modelId,
      opaqueBlobCompatibilityScope: scope,
      providerModels: { [upstreamId]: stubProviderModel({ id: modelId, upstreamModelId: modelId, opaqueBlobCompatibilityScope: scope }) },
    },
  }));
};
