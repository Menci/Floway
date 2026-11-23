import { isEqual } from 'es-toolkit';

import type { AffinityIdentity, AffinityTarget, DecodedAffinityBlob, OpaqueBlobCompatibilityIdentity } from './carrier.ts';
import type { RouteCandidate } from '../../../pipeline/services.ts';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';
import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

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

export type AffinityCandidate = ModelCandidate | RouteCandidate;

export const affinityIdentityForCandidate = (candidate: AffinityCandidate): AffinityIdentity => {
  const upstreamId = 'providerModel' in candidate ? candidate.upstreamId : candidate.provider.upstreamId;
  const model = 'providerModel' in candidate ? candidate.providerModel : providerModelOf(candidate);
  return {
    upstreamId,
    modelId: model.id,
    ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
    opaqueBlobCompatibilityIdentity: materializeOpaqueBlobCompatibilityIdentity(
      model.opaqueBlobCompatibilityScope, upstreamId, model.upstreamModelId,
    ),
  };
};

const candidateMatchesExactTarget = (candidate: AffinityCandidate, affinity: AffinityTarget): boolean =>
  candidateMatchesPhysicalTarget(candidate, affinity)
  // Alias targets always carry a rules object, while direct candidates omit
  // it. Both shapes describe the same no-overlay variant when the object is
  // empty, which lets a pre-alias session follow its real binding after a
  // same-name alias starts shadowing that model.
  && isEqual(candidate.rules ?? {}, affinity.rules ?? {});

const candidateMatchesPhysicalTarget = (candidate: AffinityCandidate, affinity: AffinityTarget): boolean => {
  const upstreamId = 'providerModel' in candidate ? candidate.upstreamId : candidate.provider.upstreamId;
  const modelId = 'providerModel' in candidate ? candidate.modelId : candidate.model.id;
  return upstreamId === affinity.upstreamId && modelId === affinity.modelId;
};

export const compatibilityIdentityForCandidate = (candidate: AffinityCandidate): OpaqueBlobCompatibilityIdentity =>
  affinityIdentityForCandidate(candidate).opaqueBlobCompatibilityIdentity;

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

export interface AffinityAnalysis {
  readonly requiredTargets: readonly AffinityIdentity[];
}

export const uniqueRequiredAffinityTargets = (targets: readonly AffinityIdentity[]): readonly AffinityIdentity[] =>
  targets.filter((target, index) => targets.findIndex(existing => sameCompatibilityIdentity(
    existing.opaqueBlobCompatibilityIdentity, target.opaqueBlobCompatibilityIdentity,
  )) === index);

interface AcceptedAffinity {
  readonly kind: 'accepted';
  readonly degrades: boolean;
  readonly preferred?: boolean;
}

interface RejectedAffinity { readonly kind: 'rejected' }

export type AffinityScore = RejectedAffinity | AcceptedAffinity;
export type AffinityEvaluation<Payload> = RejectedAffinity | (AcceptedAffinity & { readonly payload: Payload });

export type ScoreAffinity<Analysis extends AffinityAnalysis, Payload> =
  (analysis: Analysis, candidate: RouteCandidate, payload: Payload) => AffinityScore;

export type EvaluateAffinity<Analysis extends AffinityAnalysis, Payload> =
  (analysis: Analysis, candidate: RouteCandidate, payload: Payload) => AffinityEvaluation<Payload>;
