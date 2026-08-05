import { isEqual } from 'es-toolkit';

import type { AffinityTarget, DecodedAffinityBlob } from './carrier.ts';
import type { ChatServeFailure } from '../errors.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface AffinityRequestAnalysis<T> {
  readonly requiredTargets: readonly AffinityTarget[];
  readonly evaluateCandidate: (candidate: ModelCandidate) => CandidateAffinityEvaluation<T>;
}

export type CandidateAffinityEvaluation<T> =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'accepted'; readonly degrades: boolean; readonly materialize: () => T };

export interface AffinityCandidateSelection<T> {
  readonly candidates: readonly ModelCandidate[];
  readonly payloadFor: (candidate: ModelCandidate) => T;
}

export type AffinitySelectionFailure = Extract<ChatServeFailure, { kind: 'routing-unavailable' }>;

export type OptionalAffinityBlobProjection =
  | { readonly kind: 'preserve'; readonly value: string }
  | { readonly kind: 'remove'; readonly degrades: boolean };

export type RequiredAffinityBlobProjection =
  | OptionalAffinityBlobProjection
  | { readonly kind: 'reject'; readonly requiredTarget: AffinityTarget };

const sameRequiredTarget = (left: AffinityTarget, right: AffinityTarget): boolean =>
  left.upstreamId === right.upstreamId && left.modelId === right.modelId;

const candidateMatchesExactTarget = (candidate: ModelCandidate, affinity: AffinityTarget): boolean =>
  candidate.provider.upstreamId === affinity.upstreamId
  && candidate.model.id === affinity.modelId
  // Alias targets always carry a rules object, while direct candidates omit
  // it. Both shapes describe the same no-overlay variant when the object is
  // empty, which lets a pre-alias session follow its real binding after a
  // same-name alias starts shadowing that model.
  && isEqual(candidate.rules ?? {}, affinity.rules ?? {});

export const candidateSatisfiesAffinityTarget = (candidate: ModelCandidate, target: AffinityTarget): boolean =>
  candidate.provider.upstreamId === target.upstreamId && candidate.model.id === target.modelId;

export const projectOptionalAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: ModelCandidate,
): OptionalAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value };
  const compatible = candidateMatchesExactTarget(candidate, decoded.affinity);
  if (!compatible || decoded.value === undefined) return { kind: 'remove', degrades: decoded.value !== undefined };
  return { kind: 'preserve', value: decoded.value };
};

export const projectRequiredAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: ModelCandidate,
): RequiredAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value };
  if (!candidateSatisfiesAffinityTarget(candidate, decoded.affinity)) return { kind: 'reject', requiredTarget: decoded.affinity };
  if (decoded.value === undefined) return { kind: 'remove', degrades: false };
  return { kind: 'preserve', value: decoded.value };
};

export const defineAffinityRequest = <T>(
  requiredTargets: readonly AffinityTarget[],
  evaluate: (candidate: ModelCandidate) => CandidateAffinityEvaluation<T>,
): AffinityRequestAnalysis<T> => {
  const uniqueRequiredTargets: AffinityTarget[] = [];
  for (const target of requiredTargets) {
    if (!uniqueRequiredTargets.some(existing => sameRequiredTarget(existing, target))) uniqueRequiredTargets.push(target);
  }
  const evaluations = new WeakMap<ModelCandidate, CandidateAffinityEvaluation<T>>();
  return {
    requiredTargets: uniqueRequiredTargets,
    evaluateCandidate: candidate => {
      const existing = evaluations.get(candidate);
      if (existing !== undefined) return existing;
      const candidateEvaluation = evaluate(candidate);
      const satisfiesRequirements = uniqueRequiredTargets.every(target => candidateSatisfiesAffinityTarget(candidate, target));
      if ((candidateEvaluation.kind === 'accepted') !== satisfiesRequirements) {
        throw new Error('Affinity candidate evaluation disagrees with the request requirement analysis');
      }
      if (candidateEvaluation.kind === 'rejected') {
        evaluations.set(candidate, candidateEvaluation);
        return candidateEvaluation;
      }
      let materialized: { readonly value: T } | undefined;
      const accepted: CandidateAffinityEvaluation<T> = {
        kind: 'accepted',
        degrades: candidateEvaluation.degrades,
        materialize: () => {
          materialized ??= { value: candidateEvaluation.materialize() };
          return materialized.value;
        },
      };
      evaluations.set(candidate, accepted);
      return accepted;
    },
  };
};

export const selectAffinityCandidates = <T>(
  candidates: readonly ModelCandidate[],
  affinity: AffinityRequestAnalysis<T>,
): AffinityCandidateSelection<T> | AffinitySelectionFailure => {
  if (affinity.requiredTargets.length > 1) {
    return {
      kind: 'routing-unavailable',
      message: `Client-carried state requires multiple incompatible targets: ${affinity.requiredTargets.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`,
    };
  }

  const accepted: Array<{
    readonly candidate: ModelCandidate;
    readonly evaluation: Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }>;
  }> = [];
  for (const candidate of candidates) {
    const evaluation = affinity.evaluateCandidate(candidate);
    if (evaluation.kind === 'accepted') accepted.push({ candidate, evaluation });
  }
  if (affinity.requiredTargets.length === 1 && accepted.length === 0) {
    const [required] = affinity.requiredTargets;
    return {
      kind: 'routing-unavailable',
      message: `Client-carried state requires unavailable target '${required.upstreamId}/${required.modelId}'.`,
    };
  }

  const nonDegrading: typeof accepted = [];
  const degrading: typeof accepted = [];
  for (const item of accepted) {
    (item.evaluation.degrades ? degrading : nonDegrading).push(item);
  }
  const ordered = nonDegrading.length === 0 ? accepted : [...nonDegrading, ...degrading];
  const evaluations = new WeakMap(ordered.map(item => [item.candidate, item.evaluation]));
  return {
    candidates: ordered.map(item => item.candidate),
    payloadFor: candidate => {
      const evaluation = evaluations.get(candidate);
      if (evaluation === undefined) throw new Error('Affinity payload requested for a candidate outside the selected set');
      return evaluation.materialize();
    },
  };
};
