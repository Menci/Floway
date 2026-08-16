// Resolving a model to the upstreams that can serve it, and running the suffix once per
// candidate until one answers. Both are ordinary stages: nothing in the framework knows
// what a retry is, and array position is the whole of the statement that what follows
// `failover` is the per-attempt segment.
//
// Neither names a family's own key. Branching is a capability of the framework and what
// something branches on is a concept in the domain, so the family hands in the two
// domain-shaped things — how to narrow a candidate, and how to read an attempt's outcome —
// and these stages stay written against the shared space alone. That is also what lets
// them compose into a pipeline over any family's larger space with no variance question to
// lose: assembly reasons over declarations, which are strings.

import type { GatewayFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { Facts } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

/** What a family narrows its candidates by, and what it says when nothing is left. A
 *  candidate that resolves but cannot serve this request — no endpoint for the kind, or a
 *  payload the target protocol cannot express — is not a candidate, and saying why is what
 *  turns an empty list into a usable 400 rather than a bare 404. */
export interface Narrowing<Refusal extends object> {
  readonly kind: ModelKind;
  /** Keeps a candidate, or says in one phrase why it cannot serve this request. */
  readonly reject: (candidate: ModelCandidate) => string | null;
  /** What this family answers with when there is no candidate to try. The family decides
   *  which of its own keys carries the failure, which is why the refusal slice is a type
   *  parameter rather than a shared key: a reusable stage whose short-circuit provides
   *  family-specific keys cannot be written against the shared space alone. */
  readonly refuse: (status: number, message: string) => Refusal;
  /** The same keys as strings, so assembly can check that a short-circuit here covers what
   *  the stages above it need. */
  readonly refuses: readonly (keyof Refusal)[];
}

/**
 * Provides `serve.candidates`, or answers with the failure that says why there are none —
 * both traits, because "no upstream serves this model" is an answer this stage already
 * holds and nothing below it could produce one.
 */
export const resolveCandidates = <Refusal extends object>(narrowing: Narrowing<Refusal>) => defineStage<
  Slice<'serve.model'>,                                  // what arrives
  Slice<'serve.model' | 'serve.candidates'>,             // what it hands down
  Slice<'response.usage.billable'>,                      // what comes back
  Slice<'response.usage.billable'>,                      // what it hands up, having descended
  Slice<'response.usage.billable'> & Refusal,            // and what it answers with instead
  GatewayServices
>({
  name: 'resolveCandidates',
  through: {
    request: { needs: ['serve.model'], consumes: [], provides: ['serve.candidates'] },
    response: { needs: ['response.usage.billable'], consumes: [], provides: [] },
  },
  return: { provides: ['response.usage.billable', ...narrowing.refuses] },
  execute: async (facts, next, use) => {
    const model = facts['serve.model'];
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: use.gateway.upstreamIds,
      model,
      kind: narrowing.kind,
      scheduler: use.gateway.backgroundScheduler,
      runtimeLocation: use.gateway.runtimeLocation,
    });

    // An empty billed set is what "we did not call an upstream" looks like. The settlement
    // stages still run and still write; the row simply names no billed entity.
    const refuse = (status: number, message: string) =>
      move({ ...facts, 'response.usage.billable': [], ...narrowing.refuse(status, message) });

    if (candidates.length === 0) {
      const missing = sawModel
        ? `Model ${model} does not support ${narrowing.kind}.`
        : `Model ${model} is not available on any configured upstream.`;
      return refuse(sawModel ? 400 : 404, appendFailedUpstreams(missing, failedUpstreams));
    }

    const refused = new Set<string>();
    const viable = candidates.filter(candidate => {
      const why = narrowing.reject(candidate);
      if (why !== null) refused.add(why);
      return why === null;
    });
    if (viable.length === 0) {
      return refuse(400, appendFailedUpstreams(
        `Model ${model} does not support this request: ${[...refused].join('; ')}.`,
        failedUpstreams,
      ));
    }

    use.log.debug('resolved candidates', { model, viable: viable.length, resolved: candidates.length });
    return await next({ ...facts, 'serve.candidates': move(viable) });
  },
});

/**
 * Runs what follows it once per candidate and returns the first that did not fail.
 *
 * The losing attempts' bodies are its own — that is what `consumes` declares on the way up
 * — and the winner's rides onward, which is what `provides` declares. Failover never
 * breaks a stream: once one has opened there is nothing to fail over to, and the family's
 * edge is what settles that by sitting above this stage rather than below it.
 */
export const failover = (failed: (handedUp: Facts) => boolean) => defineStage<
  Slice<'serve.candidates'>,
  Slice<'serve.candidates' | 'route.candidate'>,
  Slice<'response.http.body' | 'response.usage.billable'>,
  Slice<'response.http.body' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'failover',
  through: {
    request: { needs: ['serve.candidates'], consumes: [], provides: ['route.candidate'] },
    response: {
      needs: ['response.usage.billable'],
      consumes: ['response.http.body'],
      provides: ['response.http.body'],
    },
  },
  execute: async (facts, next, use) => {
    let last: Slice<'response.http.body' | 'response.usage.billable'> | undefined;
    for (const candidate of facts['serve.candidates']) {
      // Per-attempt telemetry state, cleared before control leaves, so a mid-attempt throw
      // still attributes its performance row to the candidate that was being tried.
      use.gateway.attempt.upstreamCallStartedAt = null;
      use.gateway.attempt.firstOutputTokenAt = null;
      last = await next({ ...facts, 'route.candidate': move(candidate) });
      if (!failed(last as Facts)) return last;
      use.log.info('candidate failed, trying the next', { upstream: candidate.provider.upstreamId });
    }
    if (last === undefined) throw new Error('failover: assembly handed it an empty candidate list');
    // Every candidate failed, and the last failure is the base — so the client sees real
    // upstream telemetry rather than a synthesized gateway envelope.
    return last;
  },
});
