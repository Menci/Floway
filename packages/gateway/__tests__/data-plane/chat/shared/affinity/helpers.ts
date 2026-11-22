import type { CandidateAffinityEvaluation, RouteAffinityRequestAnalysis } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import type { RouteCandidate } from '@floway-dev/provider';

export const acceptedAffinityEvaluation = <T>(
  analysis: RouteAffinityRequestAnalysis<T>,
  candidate: RouteCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') {
    throw new Error('Expected accepted affinity candidate');
  }
  return evaluation;
};
