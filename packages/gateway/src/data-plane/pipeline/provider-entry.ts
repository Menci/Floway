import type { AttemptSelector } from './facts.ts';
import { filterInboundHeadersForProvider } from '../shared/inbound-headers.ts';
import { move } from '@floway-dev/pipeline';
import { providerModelFacts, providerModelOf, type ModelCandidate, type ProviderRequest } from '@floway-dev/provider';

export const providerEntry = <P>(
  facts: { 'route.attempt': AttemptSelector; 'ingress.http.headers': readonly (readonly [string, string])[] },
  candidate: ModelCandidate,
  payload: P,
  forwardedHeaders: readonly (readonly [string, string])[] = facts['ingress.http.headers'],
): ProviderRequest<P> & Record<string, unknown> => move({
  ...facts,
  'request.provider.model': providerModelFacts(providerModelOf(candidate)),
  'request.provider.payload': payload,
  'request.http.callId': facts['route.attempt'].candidateId,
  'request.http.headers': [...filterInboundHeadersForProvider(
    new Headers(forwardedHeaders.map(([name, value]): [string, string] => [name, value])),
    candidate.provider,
  )],
});
