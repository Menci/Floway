// What every chat chain runs, and what it takes from the family that runs it.
//
// Chat differs from the families in PR 2 in two ways, and both are here rather than in each
// family. Candidates are ordered by affinity before they are tried, because client-carried
// state pins a turn to the upstream that issued it. And the last stage picks a *wire*: a
// candidate that serves this request may speak a different protocol than the client did, so
// what follows the fork is decided per candidate rather than at assembly.
//
// The second is why dispatch is an `into` stage. Only a pipeline's last stage may name what
// comes next, and failover re-runs the whole suffix — including that last stage — so the
// next candidate re-picks its own wire with no mechanism of its own.

import type { ChatSourceProtocol } from './facts.ts';
import type { AttemptSelector, GatewayFacts } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { selectAffinityCandidates } from './shared/affinity/index.ts';
import type { AffinityRequestAnalysis } from './shared/affinity/selection.ts';
import type { ChatGatewayCtx } from './shared/gateway-ctx.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

/** What a chat family needs beyond the shared services: the affinity selection this run
 *  made, so the stage that dials can ask for the payload the winning candidate is owed. */
export interface ChatServices extends GatewayServices {
  readonly gateway: ChatGatewayCtx;
  readonly rememberChatSelection: (payloadFor: (candidate: ModelCandidate) => unknown) => void;
  readonly chatPayloadFor: (selector: AttemptSelector) => unknown;
  readonly selectAffinity: (candidate: ModelCandidate) => void;
}

/** How a source protocol narrows and orders the candidates that could serve it. */
export interface ChatNarrowing<Refusal extends object> {
  readonly source: ChatSourceProtocol;
  /** Which upstream wires this source prefers, in order. A candidate none of whose endpoints
   *  appear here cannot serve the request whatever else it offers. */
  readonly canServe: (candidate: ModelCandidate) => boolean;
  /** What the client's own turn says about where it must go. Client-carried state — a
   *  Responses `previous_response_id`, an encrypted reasoning blob — pins the turn to the
   *  upstream that issued it, so this runs before any candidate is tried. */
  readonly affinity: (gateway: ChatGatewayCtx) => Promise<AffinityRequestAnalysis<unknown>>;
  readonly unsupported: (model: string) => string;
  readonly refuse: (status: number, message: string) => Refusal;
  readonly refuses: readonly (keyof Refusal)[];
}

/**
 * Provides `serve.candidates` in the order affinity asks for, or answers with the failure
 * that says why there are none.
 *
 * Affinity can refuse outright — a turn whose state requires two incompatible upstreams has
 * nowhere to go — and that is an answer this stage already holds, which is why it carries
 * the `return` trait alongside `through`.
 */
export const resolveChatCandidates = <Refusal extends object>(narrowing: ChatNarrowing<Refusal>) => defineStage<
  Slice<'serve.model'>,
  Slice<'serve.model' | 'serve.candidates'>,
  Slice<'response.usage.billable' | 'response.http.headers'>,
  Slice<'response.usage.billable' | 'response.http.headers'>,
  Slice<'response.usage.billable' | 'response.http.headers'> & Refusal,
  ChatServices
>({
  name: 'resolveChatCandidates',
  through: {
    request: { needs: ['serve.model'], consumes: [], provides: ['serve.candidates'] },
    response: { needs: ['response.usage.billable', 'response.http.headers'], consumes: [], provides: [] },
  },
  return: { provides: ['response.usage.billable', 'response.http.headers', ...narrowing.refuses] },
  execute: async (facts, next, use) => {
    const model = facts['serve.model'];
    const affinity = await narrowing.affinity(use.gateway);
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: use.gateway.upstreamIds,
      model,
      kind: 'chat',
      scheduler: use.gateway.backgroundScheduler,
      runtimeLocation: use.gateway.runtimeLocation,
    });

    // An empty billed set is what "we did not call an upstream" looks like, and an empty
    // header list is the same statement on the other key.
    const refuse = (status: number, message: string) =>
      move({
        ...facts,
        'response.usage.billable': [],
        'response.http.headers': [],
        ...narrowing.refuse(status, message),
      });

    const viable = candidates.filter(candidate => narrowing.canServe(candidate));
    const selection = selectAffinityCandidates(viable, affinity);
    // A turn whose carried state needs two upstreams at once is a request the client can fix
    // by not carrying it, which is what every family called this before: a 400, not a
    // conflict with something the gateway holds.
    if ('kind' in selection) return refuse(400, selection.message);
    if (selection.candidates.length === 0) {
      const missing = sawModel
        ? narrowing.unsupported(model)
        : `Model ${model} is not available on any configured upstream.`;
      return refuse(sawModel ? 400 : 404, appendFailedUpstreams(missing, failedUpstreams));
    }

    // The live half stays with the resolver; only selectors travel. The payload a candidate
    // is owed is part of that live half — affinity materializes it per candidate, and it
    // carries the client's own state rewritten for the upstream that will see it.
    use.rememberCandidates(selection.candidates);
    use.rememberChatSelection(selection.payloadFor);
    use.log.debug('resolved chat candidates', { model, viable: selection.candidates.length, resolved: candidates.length });
    return await next({ ...facts, 'serve.candidates': move(selection.candidates.map(selectorFor)) });
  },
});

/** Everything about a candidate that is data. The live half — the provider instance, the
 *  fetcher, the models cache — stays out of the record and is looked back up by the
 *  resolver service at the moment of the call. */
const selectorFor = (candidate: ModelCandidate): AttemptSelector => ({
  upstreamId: candidate.provider.upstreamId,
  modelId: candidate.model.id,
  flags: [...providerModelOf(candidate).enabledFlags],
});
