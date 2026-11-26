import type { AffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { Candidate } from '../../../../../src/data-plane/pipeline/facts.ts';
import { toProviderModelFact, type ProviderModel, type ProviderUpstream } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

export const stubChatCandidate = (overrides: {
  upstream?: Partial<ProviderUpstream>;
  model?: Partial<ProviderModel>;
  rules?: Candidate['rules'];
} = {}): Candidate => ({
  upstream: { id: 'test-upstream', name: 'Test Upstream', kind: 'custom', config: {}, ...overrides.upstream },
  model: toProviderModelFact(stubProviderModel(overrides.model)),
  ...(overrides.rules === undefined ? {} : { rules: overrides.rules }),
});

export const acceptedAffinityEvaluation = <T>(
  analysis: AffinityRequestAnalysis<T>,
  candidate: Candidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') {
    throw new Error('Expected accepted affinity candidate');
  }
  return evaluation;
};
