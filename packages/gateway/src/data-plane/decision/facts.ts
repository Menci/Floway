import type { GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { DecisionProtocol, JsonObject } from '@floway-dev/protocols/common';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';

/** What an upstream answered, as JSON whose numbers keep their source tokens. It is held whole
 *  rather than parsed into the canonical form, because a same-dialect client is answered with
 *  the upstream's own document and only a translation needs the canonical one. */
export interface DecisionAnswer {
  readonly body: JsonObject;
}

/** Decision's own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface DecisionFacts extends GatewayFacts {
  /** Which of the two decision dialects the client spoke. It belongs to the ingress and stays
   *  put: the answer is rendered back into it whatever the upstream spoke. */
  'ingress.decision.sourceProtocol': DecisionProtocol;
  'request.decision.canonical': CanonicalDecisionRequest;
  'response.decision.answer': DecisionAnswer | Failure;
  /** Which dialect the attempt spoke, so the edge knows what it is rendering from. */
  'response.decision.targetProtocol': DecisionProtocol;
  /** What the client is actually sent, in its own dialect. */
  'response.decision.rendered': object;
}

export type Fields<K extends keyof DecisionFacts> = { [P in K]: DecisionFacts[P] };
