import type { AffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export const acceptedAffinityEvaluation = <T>(
  analysis: AffinityRequestAnalysis<T>,
  candidate: ModelCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') {
    throw new Error('Expected accepted affinity candidate');
  }
  return evaluation;
};
