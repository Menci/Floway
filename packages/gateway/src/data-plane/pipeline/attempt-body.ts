// What a provider is handed when a stage dials it.
//
// The two sides of this boundary disagree about ownership, and both are right. A record's
// values are frozen — a fact that could be edited after the event is not a fact — while a
// provider's interceptors shape the body they are given in place, down to nested nodes:
// Copilot writes `copilot_cache_control` onto individual messages, and its initiator rule
// writes into a nested field of an Anthropic Messages payload.
//
// Spreading a frozen fact produces a fresh top level over frozen children, so those writes
// throw — as a 502 carrying `Cannot add property …, object is not extensible`, raised at the
// point in the stack least able to explain it. What crosses this boundary is therefore a copy
// the provider owns outright, children included.
//
// The copy costs one pass over the payload, beside the serialization the dial performs
// immediately afterwards. What it buys is that a provider may keep being written the way every
// provider here is already written.

import type { ModelCandidate } from '@floway-dev/provider';

/**
 * The body for this attempt: the record's request, copied for the provider, addressed to the
 * model the candidate resolved, with the alias' own rules applied over it.
 *
 * The id the client addressed does not travel. An alias is a gateway concept — the provider
 * re-stamps whatever it resolved upstream — so the key is dropped rather than forwarded, and
 * the alias' rules apply to the body that is actually sent.
 */
export const bodyForAttempt = <T extends { readonly model: string }>(
  recorded: T,
  candidate: ModelCandidate,
  applyRules: (body: T, rules: NonNullable<ModelCandidate['rules']>) => void,
): Omit<T, 'model'> => {
  const payload = { ...structuredClone(recorded), model: candidate.model.id } as T;
  if (candidate.rules !== undefined) applyRules(payload, candidate.rules);
  const { model: _addressed, ...body } = payload;
  return body;
};
