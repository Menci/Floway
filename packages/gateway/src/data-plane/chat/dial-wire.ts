import type { ChatServices } from './services.ts';
import type { RequestKey, ChatWire } from './wire.ts';
import type { AttemptSelector } from '../pipeline/facts.ts';
import { defineStage, type Use } from '@floway-dev/pipeline';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';

/** How a source protocol reaches an upstream. */
export interface ChatWiring {
  /** The request key of the protocol the client spoke. It names the stage, so a dump says
   *  which chain forked without the name having to be written twice. */
  readonly source: RequestKey;
  /** What the chain below this stage reads. A wire is built against the candidate it will
   *  dial, so assembly cannot ask one what it needs — the family says it here, and that is
   *  what puts those keys in the serve pipeline's entry contract. */
  readonly needs: readonly string[];
  /** What comes back through here, whichever wire ran. Every wire hands up this family's own
   *  keys, which is what makes them interchangeable. */
  readonly provides: readonly string[];
  /** Which wire this candidate is reachable on. Total by contract: serve narrowed the
   *  candidates with the same picker's `canServe`, so a candidate that reached here has one
   *  of the endpoints the preference list names. */
  readonly pick: (endpoints: ModelEndpoints) => ChatTargetApi;
  /** The chain for one wire, built against the candidate that will be dialled — which is what
   *  lets a translation close over the model it is translating for. */
  readonly wire: (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>) => ChatWire;
}

/**
 * Picks this candidate's wire and hands into the chain for it.
 *
 * It is last, which is what earns it the right to name a target at all, and it holds no
 * state across candidates: what re-decides for the next candidate is failover re-running the
 * suffix, which re-runs this stage.
 */
export const dialChatWire = (wiring: ChatWiring) => defineStage<
  { 'route.attempt': AttemptSelector } & Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  ChatServices
>({
  name: `dialChatWire:${wiring.source}`,
  into: {
    request: { needs: ['route.attempt', ...wiring.needs], consumes: [], provides: [] },
    // Nothing is read on the way back — a wire hands up this family's own keys and they ride
    // through — but this is where they enter the chain, so this is the stage that provides
    // them and the runner checks that the wire delivered.
    response: { needs: [], consumes: [], provides: wiring.provides },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const target = wiring.pick(candidate.model.endpoints);
    use.log.debug('dialling', { upstream: facts['route.attempt'].upstreamId, wire: target });
    return await next(facts, wiring.wire(target, candidate, use));
  },
});
