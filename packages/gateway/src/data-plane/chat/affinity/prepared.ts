import { candidateMatchesAffinity } from './candidate.ts';
import type { AffinityTarget, DecodedAffinityBlob } from './types.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface PreparedAffinityPayload<T> {
  readonly affinities: readonly AffinityTarget[];
  readonly payloadForCandidate: (candidate: ModelCandidate) => T;
}

export type CandidateBlob =
  | { readonly present: false; readonly owned: true; readonly compatible: boolean }
  | { readonly present: true; readonly owned: false; readonly compatible: false; readonly value: string }
  | { readonly present: true; readonly owned: true; readonly compatible: true; readonly value: string };

export const blobForCandidate = (decoded: DecodedAffinityBlob, candidate: ModelCandidate): CandidateBlob => {
  if (decoded.kind === 'foreign') return { present: true, owned: false, compatible: false, value: decoded.value };
  const compatible = candidateMatchesAffinity(candidate, decoded.envelope.affinity);
  if (!compatible || decoded.value === undefined) return { present: false, owned: true, compatible };
  return { present: true, owned: true, compatible: true, value: decoded.value };
};

export const ownedAffinities = (decoded: Iterable<DecodedAffinityBlob>): AffinityTarget[] =>
  [...decoded].flatMap(blob => blob.kind === 'owned' ? [blob.envelope.affinity] : []);
