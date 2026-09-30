import type { AffinityTarget, OpaqueBlobCompatibilityIdentity } from './carrier.ts';
import { getRepo } from '../../../../repo/index.ts';
import { materializeOpaqueBlobCompatibilityIdentity, type OpaqueBlobCompatibilityScope } from '@floway-dev/protocols/common';
import { isRecord, publicModelId, type UpstreamModelConfig } from '@floway-dev/provider';

const materializeCompatibilityIdentity = (
  upstreamId: string,
  upstreamModelId: string,
  scope: OpaqueBlobCompatibilityScope | undefined,
): OpaqueBlobCompatibilityIdentity =>
  materializeOpaqueBlobCompatibilityIdentity(scope ?? { bindToUpstream: true }, upstreamId, upstreamModelId);

export const resolveLegacyOpaqueBlobCompatibilityIdentity = async (
  affinity: AffinityTarget,
): Promise<OpaqueBlobCompatibilityIdentity | undefined> => {
  const upstream = await getRepo().upstreams.getById(affinity.upstreamId);
  if (upstream === null) return undefined;

  const cached = upstream.modelsCache?.models.find(model => model.id === affinity.modelId);
  if (cached !== undefined) {
    return materializeCompatibilityIdentity(
      affinity.upstreamId,
      cached.upstreamModelId,
      cached.opaqueBlobCompatibilityScope,
    );
  }

  if (!isRecord(upstream.config) || !Array.isArray(upstream.config.models)) return undefined;
  const configured = (upstream.config.models as UpstreamModelConfig[])
    .find(model => publicModelId(model) === affinity.modelId);
  if (configured === undefined) return undefined;
  return materializeCompatibilityIdentity(
    affinity.upstreamId,
    configured.upstreamModelId,
    configured.opaqueBlobCompatibilityScope,
  );
};
