import { AffinityCodec, type AffinityIdentity } from './carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from './legacy.ts';
import { compatibilityIdentityForCandidate } from './selection.ts';
import type { ServeCandidate } from '../../../pipeline/facts.ts';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityIdentity;
}

export const affinityIdentityForCandidate = (candidate: ServeCandidate): AffinityIdentity => ({
  upstreamId: candidate.upstream.id,
  modelId: candidate.model.id,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForCandidate(candidate),
});

export const createAffinityCodec = (serverSecret: string): AffinityCodec =>
  new AffinityCodec(serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity);
