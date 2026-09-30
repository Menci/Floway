import type { AttemptSelector } from './facts.ts';
import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

export const createCandidateRegistry = () => {
  const live: ModelCandidate[] = [];
  return {
    rememberCandidates: (candidates: readonly ModelCandidate[]): readonly AttemptSelector[] => candidates.map(candidate => {
      const candidateId = live.length;
      live.push(candidate);
      return {
        candidateId,
        upstreamId: candidate.provider.upstreamId,
        modelId: candidate.model.id,
        flags: [...providerModelOf(candidate).enabledFlags],
      };
    }),
    resolveAttempt: (selector: AttemptSelector): ModelCandidate => {
      const candidate = live[selector.candidateId];
      if (candidate === undefined) throw new Error(`resolveAttempt: nothing live for candidate ${selector.candidateId}; the selector did not come from this run`);
      return candidate;
    },
  };
};
