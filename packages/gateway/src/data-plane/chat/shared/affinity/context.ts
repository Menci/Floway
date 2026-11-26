import type { AffinityCodec, AffinityIdentity } from './carrier.ts';
import { compatibilityIdentityForCandidate } from './selection.ts';
import type { Candidate } from '../../../pipeline/facts.ts';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityIdentity;
}

export const affinityIdentityForCandidate = (candidate: Candidate): AffinityIdentity => ({
  upstreamId: candidate.upstream.id,
  modelId: candidate.model.id,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForCandidate(candidate),
});
