import type { ChatServeFailure } from './errors.ts';
import type { ModelCandidate } from '@floway-dev/provider';

// Generic over the candidate type so call sites can narrow back to their
// concrete shape. The candidate filtering and ordering inside routing is
// shape-agnostic — it touches `candidate.provider.upstream` and
// `candidate.provider.supportsResponsesItemReference` only.
export type RoutingDecision<T extends ModelCandidate = ModelCandidate> =
  | { readonly kind: 'success'; readonly candidates: readonly T[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
