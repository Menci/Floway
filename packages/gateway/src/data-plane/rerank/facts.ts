import type { GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { RerankSourceProtocol, RerankProtocol } from '@floway-dev/protocols/common';
import type { CanonicalRerankRequest, CanonicalRerankResponse } from '@floway-dev/protocols/rerank';

/** Rerank's own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface RerankFacts extends GatewayFacts {
  /** Which of the four rerank protocols the client spoke. It belongs to the ingress and
   *  stays put: the answer is rendered back into it whatever the upstream spoke. */
  'ingress.rerank.sourceProtocol': RerankSourceProtocol;
  'request.rerank.canonical': CanonicalRerankRequest;
  'response.rerank.canonical': CanonicalRerankResponse | Failure;
  /** Which protocol the attempt spoke. A response fact, because an upstream picks the target
   *  it answers in and the edge needs it to render back into the client's — a run that never
   *  reached one carries the target its request was serialized for. */
  'response.rerank.targetProtocol': RerankProtocol;
  /** What the client is actually sent, in its own protocol. The edge provides it, so a
   *  dump shows the bytes the client received rather than the gateway's canonical form. */
  'response.rerank.rendered': Record<string, unknown>;
}

export type Fields<K extends keyof RerankFacts> = { [P in K]: RerankFacts[P] };
