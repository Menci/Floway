import type { ChatServeFailure } from './errors.ts';
import type { ProviderCandidate } from '@floway-dev/provider';

export type RoutingDecision =
  | { readonly kind: 'success'; readonly candidates: readonly ProviderCandidate[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
