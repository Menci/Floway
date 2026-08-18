// What a provider is handed when a stage dials it.
//
// The record's own children travel, by identity. One object is built here, and only because
// this is where the addressed model is stamped and then dropped; everything under it is the
// record's, frozen — a fact that could be edited after the event is not a fact — and a provider
// shapes the body it sends by rebuilding rather than by writing into what it was given. So both
// sides of this boundary agree and there is nothing to defend against.
//
// It was not always so, and the shape of the failure is worth keeping: three Copilot rules
// wrote one level down, into a message or a content block, which against a frozen record threw
// `Cannot add property …, object is not extensible` — as a 502, from the point in the stack
// least able to explain it. A deep copy here absorbed that, at the cost of one pass over every
// payload on every dial, and at the larger cost of making immutability something the gateway
// worked around. The three rules rebuild now, and so does every alias overlay: an overlay that
// wrote in place would be safe only for as long as this function happened to have rebuilt the
// level it writes to, which is the same trap one level up.
//
// So what is left is only the three things every wire was otherwise writing by hand.

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
