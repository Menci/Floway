import type { GatewayServices } from './services.ts';
import type { Slice } from './stage-contracts.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';

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
  Slice<'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,           // what comes back
  Slice<'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,           // what it hands up, having descended
  Slice<'response.usage.billable' | 'response.http.headers' | 'response.http.status'> & Refusal, // and what it answers with instead
  GatewayServices
>({
  name: 'resolveCandidates',
  through: {
    request: { needs: ['serve.model'], consumes: [], provides: ['serve.candidates'] },
    response: { needs: ['response.usage.billable', 'response.http.headers'], consumes: [], provides: [] },
  },
  return: { provides: ['response.usage.billable', 'response.http.headers', 'response.http.status', ...narrowing.refuses] },
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
        'response.http.status': status,
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
    if (viable.length === 0) {
      await use.log.debug('no viable candidate', { model, refused: [...refused] });
      return refuse(400, appendFailedUpstreams(narrowing.unsupported(model, [...refused]), failedUpstreams));
    }

    await use.log.debug('resolved candidates', { model, viable: viable.length, resolved: candidates.length });
    return await next({ ...facts, 'serve.candidates': move(use.rememberCandidates(viable)) });
  },
});
