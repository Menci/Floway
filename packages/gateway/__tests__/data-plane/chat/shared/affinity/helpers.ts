import type { AffinityCandidate, AffinityIdentity, AffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { AliasRules } from '@floway-dev/protocols/common';

export const affinityCandidate = (upstreamId: string, model = 'model', rules?: AliasRules): AffinityCandidate => ({
  upstream: { upstreamId },
  model: { id: model, upstreamModelId: model, opaqueBlobCompatibilityScope: { bindToUpstream: true } },
  ...(rules === undefined ? {} : { rules }),
});

export const affinityTargetFor = (value: AffinityCandidate): AffinityIdentity => ({
  upstreamId: value.upstream.upstreamId,
  modelId: value.model.id,
  ...(value.rules === undefined ? {} : { rules: value.rules }),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.upstream.upstreamId, key: value.model.id },
});

export const acceptedAffinityEvaluation = <T>(
  analysis: AffinityRequestAnalysis<T>,
  candidate: AffinityCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') {
    throw new Error('Expected accepted affinity candidate');
  }
  return evaluation;
};
