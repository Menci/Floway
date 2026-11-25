import type { AffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { ServeCandidate } from '../../../../../src/data-plane/pipeline/facts.ts';
import { providerModelOf, toProviderModelFact, type ModelCandidate } from '@floway-dev/provider';

export const projectAffinityTestCandidate = (candidate: ModelCandidate): ServeCandidate => {
  const { provider, rules } = candidate;
  return {
    upstream: { id: provider.upstreamId, kind: provider.kind, name: provider.name, config: {} },
    model: toProviderModelFact(providerModelOf(candidate)),
    ...(rules === undefined ? {} : { rules }),
  };
};

export const acceptedAffinityEvaluation = <T>(
  analysis: AffinityRequestAnalysis<T>,
  candidate: ServeCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') {
    throw new Error('Expected accepted affinity candidate');
  }
  return evaluation;
};
