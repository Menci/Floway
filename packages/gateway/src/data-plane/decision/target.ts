import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

/** A candidate without a decision endpoint, or without a dialect to speak on it, is not a
 *  candidate. The dialect belongs to the provider, so a model that has none cannot be served. */
export const narrowing = {
  kind: 'decision' as const,
  reject: (candidate: ModelCandidate) =>
    candidate.model.endpoints.decision === undefined || providerModelOf(candidate).decisionTarget === undefined
      ? 'the upstream does not expose a decision endpoint'
      : null,
  unsupported: (model: string) => `Model ${model} does not support decision.`,
  refuse: (status: number, message: string) => ({ 'response.decision.answer': { status, message } }),
  refuses: ['response.decision.answer'] as const,
};
