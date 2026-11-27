import { isEqual } from 'es-toolkit';

import type { AffinityIdentity, AffinityTarget, DecodedAffinityBlob, OpaqueBlobCompatibilityIdentity } from './carrier.ts';
import type { ChatRoutingFailure } from '../errors.ts';
import { materializeOpaqueBlobCompatibilityIdentity, type AliasRules } from '@floway-dev/protocols/common';
import type { UpstreamModelSnapshot } from '@floway-dev/upstream';

export interface AffinityCandidate {
  readonly upstream: { readonly upstreamId: string };
  readonly model: Pick<UpstreamModelSnapshot, 'id' | 'upstreamModelId' | 'opaqueBlobCompatibilityScope'>;
  readonly rules?: AliasRules;
}

export interface AffinityRequestAnalysis<T, C extends AffinityCandidate = AffinityCandidate> {
  readonly requiredTargets: readonly AffinityIdentity[];
  readonly evaluateCandidate: (candidate: C) => CandidateAffinityEvaluation<T>;
}

export type CandidateAffinityEvaluation<T> =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'accepted'; readonly degrades: boolean; readonly preferred?: boolean; readonly materialize: () => T };

export interface AffinityCandidateSelection<T, C extends AffinityCandidate = AffinityCandidate> {
  readonly candidates: readonly C[];
  readonly payloadFor: (candidate: C) => T;
}

export type AffinitySelectionFailure = Extract<ChatRoutingFailure, { kind: 'routing-unavailable' }>;

export type OptionalAffinityBlobProjection =
  | { readonly kind: 'preserve'; readonly value: string; readonly preferred: boolean }
  | { readonly kind: 'remove'; readonly incompatible: boolean; readonly degrades: boolean; readonly preferred: boolean };

export type RequiredAffinityBlobProjection =
  | OptionalAffinityBlobProjection
  | { readonly kind: 'reject'; readonly requiredTarget: AffinityIdentity };

const sameCompatibilityIdentity = (
  left: OpaqueBlobCompatibilityIdentity,
  right: OpaqueBlobCompatibilityIdentity,
): boolean => left.upstreamId === right.upstreamId && left.key === right.key;

const candidateMatchesExactTarget = (candidate: AffinityCandidate, affinity: AffinityTarget): boolean =>
  candidate.upstream.upstreamId === affinity.upstreamId
  && candidate.model.id === affinity.modelId
  // Alias targets always carry a rules object, while direct candidates omit
  // it. Both shapes describe the same no-overlay variant when the object is
  // empty, which lets a pre-alias session follow its real binding after a
  // same-name alias starts shadowing that model.
  && isEqual(candidate.rules ?? {}, affinity.rules ?? {});

const candidateMatchesPhysicalTarget = (candidate: AffinityCandidate, affinity: AffinityTarget): boolean =>
  candidate.upstream.upstreamId === affinity.upstreamId && candidate.model.id === affinity.modelId;

export const compatibilityIdentityForCandidate = (candidate: AffinityCandidate): OpaqueBlobCompatibilityIdentity => {
  const model = candidate.model;
  return materializeOpaqueBlobCompatibilityIdentity(
    model.opaqueBlobCompatibilityScope,
    candidate.upstream.upstreamId,
    model.upstreamModelId,
  );
};

export const candidateSatisfiesAffinityIdentity = (candidate: AffinityCandidate, target: AffinityIdentity): boolean =>
  sameCompatibilityIdentity(compatibilityIdentityForCandidate(candidate), target.opaqueBlobCompatibilityIdentity);

export const projectOptionalAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: AffinityCandidate,
): OptionalAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value, preferred: true };
  const target = {
    ...decoded.affinity,
    opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
  };
  const compatible = candidateSatisfiesAffinityIdentity(candidate, target);
  const preferred = compatible && candidateMatchesExactTarget(candidate, decoded.affinity);
  if (!compatible || decoded.value === undefined) {
    return { kind: 'remove', incompatible: !compatible, degrades: decoded.value !== undefined, preferred: decoded.value === undefined || preferred };
  }
  return { kind: 'preserve', value: decoded.value, preferred };
};

export const isIncompatibleAffinityProjection = (projection: OptionalAffinityBlobProjection): boolean =>
  projection.kind === 'remove' && projection.incompatible;

export const incompatibleReasoningParts = <Part>(
  parts: readonly Part[],
  projections: ReadonlyMap<number, OptionalAffinityBlobProjection>,
  isReasoning: (part: Part) => boolean,
): ReadonlySet<number> => {
  const dropped = new Set<number>();
  if (![...projections.values()].some(isIncompatibleAffinityProjection)) return dropped;
  // An unmarked part shares its assistant turn's affinity. An explicit
  // carrier takes precedence, including a foreign signature we cannot classify.
  for (const [index, part] of parts.entries()) {
    if (!isReasoning(part)) continue;
    const projection = projections.get(index);
    if (projection === undefined || isIncompatibleAffinityProjection(projection)) dropped.add(index);
  }
  return dropped;
};

export const projectRequiredAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: AffinityCandidate,
): RequiredAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value, preferred: true };
  const target = {
    ...decoded.affinity,
    opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
  };
  if (!candidateSatisfiesAffinityIdentity(candidate, target)) return { kind: 'reject', requiredTarget: target };
  const preferred = candidateMatchesPhysicalTarget(candidate, decoded.affinity);
  if (decoded.value === undefined) return { kind: 'remove', incompatible: false, degrades: false, preferred };
  return { kind: 'preserve', value: decoded.value, preferred };
};

export const defineAffinityRequest = <T, C extends AffinityCandidate = AffinityCandidate>(
  requiredTargets: readonly AffinityIdentity[],
  evaluate: (candidate: C) => CandidateAffinityEvaluation<T>,
): AffinityRequestAnalysis<T, C> => {
  const uniqueRequiredTargets: AffinityIdentity[] = [];
  for (const target of requiredTargets) {
    if (!uniqueRequiredTargets.some(existing => sameCompatibilityIdentity(
      existing.opaqueBlobCompatibilityIdentity,
      target.opaqueBlobCompatibilityIdentity,
    ))) uniqueRequiredTargets.push(target);
  }
  const evaluations = new WeakMap<C, CandidateAffinityEvaluation<T>>();
  return {
    requiredTargets: uniqueRequiredTargets,
    evaluateCandidate: candidate => {
      const existing = evaluations.get(candidate);
      if (existing !== undefined) return existing;
      const candidateEvaluation = evaluate(candidate);
      const satisfiesRequirements = uniqueRequiredTargets.every(target => candidateSatisfiesAffinityIdentity(candidate, target));
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
        preferred: candidateEvaluation.preferred !== false,
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

export const selectAffinityCandidates = <T, C extends AffinityCandidate>(
  candidates: readonly C[],
  affinity: AffinityRequestAnalysis<T, NoInfer<C>>,
): AffinityCandidateSelection<T, C> | AffinitySelectionFailure => {
  if (affinity.requiredTargets.length > 1) {
    return {
      kind: 'routing-unavailable',
      message: `Client-carried state requires multiple incompatible targets: ${affinity.requiredTargets.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`,
    };
  }

  const accepted: Array<{
    readonly candidate: C;
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

  const preferred: typeof accepted = [];
  const compatible: typeof accepted = [];
  const degrading: typeof accepted = [];
  for (const item of accepted) {
    if (item.evaluation.degrades) degrading.push(item);
    else if (item.evaluation.preferred) preferred.push(item);
    else compatible.push(item);
  }
  const ordered = preferred.length === 0 && compatible.length === 0
    ? accepted
    : [...preferred, ...compatible, ...degrading];
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
