import type { AffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { ServeCandidate } from '../../../../../src/data-plane/pipeline/facts.ts';
import { toProviderModelFact, type ProviderModel } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

export const affinityTestCandidate = (upstreamId: string, model: Partial<ProviderModel> = {}): ServeCandidate => ({
  upstream: { id: upstreamId, kind: 'custom', name: upstreamId, config: {} },
  model: toProviderModelFact(stubProviderModel({ id: 'model', upstreamModelId: 'model', ...model })),
});

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
