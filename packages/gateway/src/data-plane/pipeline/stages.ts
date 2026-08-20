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

import type { AttemptSelector, GatewayFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { Facts } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';
import { providerModelOf } from '@floway-dev/provider';
import type { ModelCandidate } from '@floway-dev/provider';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

/** Everything about a candidate that is data. The live half — the provider instance, the
 *  fetcher, the models cache — stays out of the record and is looked back up by the
 *  resolver service at the moment of the call. */
const selectorFor = (candidate: ModelCandidate): AttemptSelector => ({
  upstreamId: candidate.provider.upstreamId,
  modelId: candidate.model.id,
  flags: [...providerModelOf(candidate).enabledFlags],
});

/** What a family narrows its candidates by, and what it says when nothing is left. A
 *  candidate that resolves but cannot serve this request — no endpoint for the kind, or a
 *  payload the target protocol cannot express — is not a candidate, and saying why is what
 *  turns an empty list into a usable 400 rather than a bare 404. */
export interface Narrowing<Refusal extends object> {
  readonly kind: ModelKind;
  /** Keeps a candidate, or says in one phrase why it cannot serve this request. */
  readonly reject: (candidate: ModelCandidate) => string | null;
  /** What the client is told when the model resolved but nothing can serve the request.
   *  `reasons` holds what `reject` said, and is empty when no candidate of this kind was
   *  found at all — which is the difference between "this model is not an embeddings model"
   *  and "this reranker cannot do what this request asks". Families differ in how much of
   *  that they spell out, so the sentence is the family's rather than this stage's. */
  readonly unsupported: (model: string, reasons: readonly string[]) => string;
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
  Slice<'serve.model' | 'serve.candidates'>,                            // what it hands down
  Slice<'response.usage.billable' | 'response.http.headers'>,           // what comes back
  Slice<'response.usage.billable' | 'response.http.headers'>,           // what it hands up, having descended
  Slice<'response.usage.billable' | 'response.http.headers'> & Refusal, // and what it answers with instead
  GatewayServices
>({
  name: 'resolveCandidates',
  through: {
    request: { needs: ['serve.model'], consumes: [], provides: ['serve.candidates'] },
    response: { needs: ['response.usage.billable', 'response.http.headers'], consumes: [], provides: [] },
  },
  return: { provides: ['response.usage.billable', 'response.http.headers', ...narrowing.refuses] },
  execute: async (facts, next, use) => {
    const model = facts['serve.model'];
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: use.gateway.upstreamIds,
      model,
      kind: narrowing.kind,
      scheduler: use.gateway.backgroundScheduler,
      runtimeLocation: use.gateway.runtimeLocation,
    });

    // An empty billed set is what "we did not call an upstream" looks like, and an empty
    // header list is the same statement on the other key. The settlement stages still run
    // and still write; the row simply names no billed entity.
    const refuse = (status: number, message: string) =>
      move({
        ...facts,
        'response.usage.billable': [],
        'response.http.headers': [],
        ...narrowing.refuse(status, message),
      });

    if (candidates.length === 0) {
      const missing = sawModel
        ? narrowing.unsupported(model, [])
        : `Model ${model} is not available on any configured upstream.`;
      return refuse(sawModel ? 400 : 404, appendFailedUpstreams(missing, failedUpstreams));
    }

    const refused = new Set<string>();
    const viable = candidates.filter(candidate => {
      const why = narrowing.reject(candidate);
      if (why !== null) refused.add(why);
      return why === null;
    });
    // The live half stays with the resolver; only selectors travel.
    use.rememberCandidates(viable);
    if (viable.length === 0) {
      use.log.debug('no viable candidate', { model, refused: [...refused] });
      return refuse(400, appendFailedUpstreams(narrowing.unsupported(model, [...refused]), failedUpstreams));
    }

    use.log.debug('resolved candidates', { model, viable: viable.length, resolved: candidates.length });
    return await next({ ...facts, 'serve.candidates': move(viable.map(selectorFor)) });
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
export interface Forking {
  /** How this family reads an attempt's outcome. Branching is the framework's; what
   *  something branches on is the domain's. */
  readonly failed: (handedUp: Facts) => boolean;
  /** The keys at which this family's attempts hand up something the run owns — an upstream
   *  body still open, most often. A family whose ending reads its answer to the end owns
   *  nothing and names nothing here, and one that streams names the key it streams at.
   *
   *  It cannot be a fixed key. Declaring `provides` for a key a family never produces makes
   *  the runner throw on the first real request, and declaring `consumes` for one it does
   *  produce and hands up makes it throw the other way. Which keys carry a resource is a
   *  statement only the family can make. */
  readonly owns: readonly string[];
}

export const failover = ({ failed, owns }: Forking) => defineStage<
  Slice<'serve.candidates'>,
  Slice<'serve.candidates' | 'route.attempt'>,
  Slice<'response.usage.billable'>,
  Slice<'response.usage.billable'>,
  GatewayServices
>({
  name: 'failover',
  through: {
    request: { needs: ['serve.candidates'], consumes: [], provides: ['route.attempt'] },
    response: {
      needs: ['response.usage.billable'],
      // Owned on the way up and handed onward: every attempt's is this stage's to release,
      // and the one it adopts rides up with ownership going with it.
      consumes: owns as never,
      provides: owns as never,
    },
  },
  execute: async (facts, next, use) => {
    let last: Slice<'response.usage.billable'> | undefined;
    for (const candidate of facts['serve.candidates']) {
      // Per-attempt telemetry state, cleared before control leaves, so a mid-attempt throw
      // still attributes its performance row to the candidate that was being tried.
      use.gateway.attempt.upstreamCallStartedAt = null;
      use.gateway.attempt.firstOutputTokenAt = null;
      last = await next({ ...facts, 'route.attempt': move(candidate) });
      if (!failed(last as Facts)) return last;
      use.log.info('candidate failed, trying the next', { upstream: candidate.upstreamId });
    }
    if (last === undefined) throw new Error('failover: assembly handed it an empty candidate list');
    // Every candidate failed, and the last failure is the base — so the client sees real
    // upstream telemetry rather than a synthesized gateway envelope.
    return last;
  },
});
