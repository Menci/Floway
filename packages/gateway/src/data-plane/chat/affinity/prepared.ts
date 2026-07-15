import { candidateMatchesAffinity } from './candidate.ts';
import type { AffinityTarget, DecodedAffinityBlob } from './types.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface PreparedAffinityPayload<T> {
  readonly affinities: readonly AffinityTarget[];
  readonly payloadForCandidate: (candidate: ModelCandidate) => T;
}

export type CandidateBlob =
  | { readonly present: false; readonly owned: true }
  | { readonly present: true; readonly owned: boolean; readonly value: string };

export const blobForCandidate = (decoded: DecodedAffinityBlob, candidate: ModelCandidate): CandidateBlob => {
  if (decoded.kind === 'foreign') return { present: true, owned: false, value: decoded.value };
  if (!candidateMatchesAffinity(candidate, decoded.envelope.affinity) || decoded.value === undefined) {
    return { present: false, owned: true };
  }
  return { present: true, owned: true, value: decoded.value };
};

export const ownedAffinities = (decoded: Iterable<DecodedAffinityBlob>): AffinityTarget[] =>
  [...decoded].flatMap(blob => blob.kind === 'owned' ? [blob.envelope.affinity] : []);
