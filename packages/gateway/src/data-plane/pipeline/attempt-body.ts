// Alias rules apply to the addressed candidate. Providers receive model-free
// request content and stamp their own wire model; unchanged descendants retain
// their identity through the immutable handoff.

import type { ModelCandidate } from '@floway-dev/provider';

/**
 * The body for this attempt: the record's request, addressed to the model the candidate
 * resolved, with the alias' own rules applied over it.
 *
 * The id the client addressed does not travel. An alias is a gateway concept — the provider
 * re-stamps whatever it resolved upstream — so the key is dropped rather than forwarded, and
 * the alias' rules apply to the body that is actually sent.
 */
export const bodyForAttempt = <T extends { readonly model: string }>(
  recorded: T,
  candidate: ModelCandidate,
  applyRules: (body: T, rules: NonNullable<ModelCandidate['rules']>) => T,
): Omit<T, 'model'> => {
  const addressed = { ...recorded, model: candidate.model.id } as T;
  const payload = candidate.rules === undefined ? addressed : applyRules(addressed, candidate.rules);
  const { model: _addressed, ...body } = payload;
  return body;
};
