import { candidateMatchesAffinity } from './candidate.ts';
import type { AffinityEvidence, DecodedAffinityBlob } from './types.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface PreparedAffinityPayload<T> {
  readonly routingEvidence: readonly AffinityEvidence[];
  readonly payloadForCandidate: (candidate: ModelCandidate) => T;
}

export type CandidateBlob =
  | { readonly present: false; readonly compatible: boolean }
  | { readonly present: true; readonly compatible: false; readonly value: string }
  | { readonly present: true; readonly compatible: true; readonly value: string };

export const blobForCandidate = (decoded: DecodedAffinityBlob, candidate: ModelCandidate): CandidateBlob => {
  if (decoded.kind === 'foreign') return { present: true, compatible: false, value: decoded.value };
  const compatible = candidateMatchesAffinity(candidate, decoded.envelope.affinity);
  if (!compatible || decoded.value === undefined) return { present: false, compatible };
  return { present: true, compatible: true, value: decoded.value };
};

export const preferredAffinityEvidence = (decoded: Iterable<DecodedAffinityBlob>): AffinityEvidence[] =>
  [...decoded].flatMap(blob => blob.kind === 'owned' ? [{ target: blob.envelope.affinity, mode: 'prefer' }] : []);
