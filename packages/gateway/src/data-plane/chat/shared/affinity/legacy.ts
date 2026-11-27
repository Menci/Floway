import type { AffinityTarget, OpaqueBlobCompatibilityIdentity } from './carrier.ts';
import { getRepo } from '../../../../repo/index.ts';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';

export const resolveLegacyOpaqueBlobCompatibilityIdentity = async (
  affinity: AffinityTarget,
): Promise<OpaqueBlobCompatibilityIdentity | undefined> => {
  const model = await getRepo().upstreamModels.getByKey(affinity.upstreamId, affinity.modelId, 'chat');
  if (model === null) return undefined;
  return materializeOpaqueBlobCompatibilityIdentity(
    model.opaqueBlobCompatibilityScope,
    affinity.upstreamId,
    model.upstreamModelId,
  );
};
