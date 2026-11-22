import { isEqual } from 'es-toolkit';

import type {
  AffinityCodec,
  AffinityIdentity,
  AffinityTarget,
  DecodedAffinityBlob,
  OpaqueBlobCompatibilityIdentity,
} from '../shared/affinity/carrier.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import { freezeValue } from '@floway-dev/pipeline';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';
import type { InternalModel, ModelCandidate, RouteCandidate } from '@floway-dev/provider';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityIdentity;
}

export type CandidateAffinityEvaluation<T> =
  | { readonly kind: 'rejected' }
  | {
    readonly kind: 'accepted';
    readonly degrades: boolean;
    readonly preferred?: boolean;
    readonly materialize: () => T;
  };

export interface RouteAffinityRequestAnalysis<T> {
  readonly requiredTargets: readonly AffinityIdentity[];
  readonly evaluateCandidate: (candidate: RouteCandidate) => CandidateAffinityEvaluation<T>;
}

export interface RouteAffinityCandidateEntry<T> {
  readonly candidate: RouteCandidate;
  readonly payload: T;
}

export interface RouteAffinityCandidateSelection<T> {
  readonly entries: ReadonlyArray<RouteAffinityCandidateEntry<T>>;
}

export type AffinitySelectionFailure = Extract<ChatServeFailure, { kind: 'routing-unavailable' }>;

export type OptionalAffinityBlobProjection =
  | { readonly kind: 'preserve'; readonly value: string; readonly preferred: boolean }
  | { readonly kind: 'remove'; readonly degrades: boolean; readonly preferred: boolean };

export type RequiredAffinityBlobProjection =
  | OptionalAffinityBlobProjection
  | { readonly kind: 'reject'; readonly requiredTarget: AffinityIdentity };

const sameCompatibilityIdentity = (
  left: OpaqueBlobCompatibilityIdentity,
  right: OpaqueBlobCompatibilityIdentity,
): boolean => left.upstreamId === right.upstreamId && left.key === right.key;

const candidateMatchesExactTarget = (candidate: RouteCandidate, affinity: AffinityTarget): boolean =>
  candidate.upstreamId === affinity.upstreamId
  && candidate.modelId === affinity.modelId
  && isEqual(candidate.rules ?? {}, affinity.rules ?? {});

const candidateMatchesPhysicalTarget = (candidate: RouteCandidate, affinity: AffinityTarget): boolean =>
  candidate.upstreamId === affinity.upstreamId && candidate.modelId === affinity.modelId;

export const compatibilityIdentityForRouteCandidate = (
  candidate: RouteCandidate,
): OpaqueBlobCompatibilityIdentity => materializeOpaqueBlobCompatibilityIdentity(
  candidate.providerModel.opaqueBlobCompatibilityScope,
  candidate.upstreamId,
  candidate.providerModel.upstreamModelId,
);

export const routeCandidateSatisfiesAffinityIdentity = (
  candidate: RouteCandidate,
  target: AffinityIdentity,
): boolean => sameCompatibilityIdentity(
  compatibilityIdentityForRouteCandidate(candidate),
  target.opaqueBlobCompatibilityIdentity,
);

export const projectOptionalRouteAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: RouteCandidate,
): OptionalAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value, preferred: true };
  const target: AffinityIdentity = {
    ...decoded.affinity,
    opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
  };
  const compatible = routeCandidateSatisfiesAffinityIdentity(candidate, target);
  const preferred = compatible && candidateMatchesExactTarget(candidate, decoded.affinity);
  if (!compatible || decoded.value === undefined) {
    return { kind: 'remove', degrades: decoded.value !== undefined, preferred: decoded.value === undefined || preferred };
  }
  return { kind: 'preserve', value: decoded.value, preferred };
};

export const projectRequiredRouteAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: RouteCandidate,
): RequiredAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value, preferred: true };
  const target: AffinityIdentity = {
    ...decoded.affinity,
    opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
  };
  if (!routeCandidateSatisfiesAffinityIdentity(candidate, target)) return { kind: 'reject', requiredTarget: target };
  const preferred = candidateMatchesPhysicalTarget(candidate, decoded.affinity);
  if (decoded.value === undefined) return { kind: 'remove', degrades: false, preferred };
  return { kind: 'preserve', value: decoded.value, preferred };
};

export const defineRouteAffinityRequest = <T>(
  requiredTargets: readonly AffinityIdentity[],
  evaluate: (candidate: RouteCandidate) => CandidateAffinityEvaluation<T>,
): RouteAffinityRequestAnalysis<T> => {
  const uniqueRequiredTargets: AffinityIdentity[] = [];
  for (const target of requiredTargets) {
    if (!uniqueRequiredTargets.some(existing => sameCompatibilityIdentity(
      existing.opaqueBlobCompatibilityIdentity,
      target.opaqueBlobCompatibilityIdentity,
    ))) uniqueRequiredTargets.push(target);
  }
  const evaluations = new WeakMap<RouteCandidate, CandidateAffinityEvaluation<T>>();
  return {
    requiredTargets: Object.freeze(uniqueRequiredTargets),
    evaluateCandidate: candidate => {
      const existing = evaluations.get(candidate);
      if (existing !== undefined) return existing;
      const evaluation = evaluate(candidate);
      const satisfiesRequirements = uniqueRequiredTargets.every(target =>
        routeCandidateSatisfiesAffinityIdentity(candidate, target));
      if ((evaluation.kind === 'accepted') !== satisfiesRequirements) {
        throw new Error('Affinity candidate evaluation disagrees with the request requirement analysis');
      }
      if (evaluation.kind === 'rejected') {
        evaluations.set(candidate, evaluation);
        return evaluation;
      }
      let materialized: { readonly value: T } | undefined;
      const accepted: CandidateAffinityEvaluation<T> = {
        ...evaluation,
        preferred: evaluation.preferred !== false,
        materialize: () => {
          materialized ??= { value: freezeValue(evaluation.materialize(), 'affinity.payload') };
          return materialized.value;
        },
      };
      evaluations.set(candidate, accepted);
      return accepted;
    },
  };
};

export const selectRouteAffinityCandidates = <T>(
  candidates: readonly RouteCandidate[],
  affinity: RouteAffinityRequestAnalysis<T>,
): RouteAffinityCandidateSelection<T> | AffinitySelectionFailure => {
  if (affinity.requiredTargets.length > 1) {
    return {
      kind: 'routing-unavailable',
      message: `Client-carried state requires multiple incompatible targets: ${affinity.requiredTargets.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`,
    };
  }

  const accepted: Array<{
    readonly candidate: RouteCandidate;
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
  return {
    entries: Object.freeze(ordered.map(item => Object.freeze({
      candidate: item.candidate,
      payload: item.evaluation.materialize(),
    }))),
  };
};

const affinityIdentityForRouteCandidate = (candidate: RouteCandidate): AffinityIdentity => ({
  upstreamId: candidate.upstreamId,
  modelId: candidate.modelId,
  ...(candidate.rules === undefined ? {} : { rules: candidate.rules }),
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForRouteCandidate(candidate),
});

export class RouteAffinityRequestContext {
  readonly codec: AffinityCodec;
  #selectedCandidate: RouteCandidate | undefined;

  constructor(
    codec: AffinityCodec,
    private readonly onSelectionChange: (candidate: RouteCandidate) => void = () => undefined,
  ) {
    this.codec = codec;
  }

  select(candidate: RouteCandidate): void {
    this.#selectedCandidate = candidate;
    this.onSelectionChange(candidate);
  }

  selectedTarget(): AffinityIdentity {
    if (this.#selectedCandidate === undefined) throw new Error('Affinity target requested before a candidate was selected');
    return affinityIdentityForRouteCandidate(this.#selectedCandidate);
  }

  egressOptions(): AffinityEgressOptions {
    return { codec: this.codec, affinity: this.selectedTarget() };
  }
}

export const routeCandidateAsLegacySelection = (candidate: RouteCandidate): ModelCandidate => {
  const provider = Object.freeze({
    upstreamId: candidate.upstreamId,
    kind: candidate.kind,
    name: candidate.upstreamName,
    inboundHeaderAllowlist: Object.freeze([]),
    disabledPublicModelIds: Object.freeze([]),
    modelPrefix: null,
    modelsCache: null,
    instance: Object.freeze({
      runScheduledTask: async () => undefined,
      getProvidedModels: async () => Object.freeze([]),
      callAlphaSearch: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAICompletions: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAIChatCompletions: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAIResponses: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callAnthropicMessages: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callAnthropicMessagesCountTokens: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callGeminiGenerateContent: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callGeminiGenerateContentCountTokens: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAIEmbeddings: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAIImagesGenerations: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAIImagesEdits: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callOpenAIAudioTranscriptions: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callRerank: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
      callDecision: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
    }),
  });
  const model: InternalModel = {
    id: candidate.modelId,
    limits: candidate.limits,
    kind: candidate.providerModel.kind,
    endpoints: candidate.endpoints,
    ...(candidate.providerModel.pricing === undefined ? {} : { pricing: candidate.providerModel.pricing }),
    providerModels: {
      [candidate.upstreamId]: {
        ...candidate.providerModel,
        enabledFlags: new Set(candidate.providerModel.enabledFlags),
      },
    },
  };
  return {
    provider,
    model: Object.freeze(model),
    fetcher: async () => { throw new Error('Route affinity candidate is not dispatchable'); },
    ...(candidate.rules === undefined ? {} : { rules: candidate.rules }),
  };
};
