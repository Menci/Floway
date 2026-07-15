import type { ChatServeFailure } from './errors.ts';
import type { ModelCandidate } from '@floway-dev/provider';

// Generic over the candidate type so call sites can narrow back to their
// concrete shape. The candidate filtering and ordering inside routing is
// shape-agnostic and preserves the concrete candidate objects it receives.
export type RoutingDecision<T extends ModelCandidate = ModelCandidate> =
  | { readonly kind: 'success'; readonly candidates: readonly T[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
