import type { ChatFacts, ChatRequestKey } from './facts.ts';
import type { ChatServices } from './services.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { selectAffinityCandidates } from './shared/affinity/index.ts';
import type { AffinityRequestAnalysis } from './shared/affinity/selection.ts';
import type { ChatGatewayCtx } from './shared/gateway-ctx.ts';
import type { Slice } from './stage-contracts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ModelCandidate } from '@floway-dev/provider';

/** Why the gateway refused before it reached an upstream. A protocol's envelope names the
 *  condition in its own words, and this is what it names. */
export type ChatRefusal = 'routing-unavailable' | 'model-unsupported' | 'model-missing';

/** How a source protocol narrows and orders the candidates that could serve it. */
export interface ChatNarrowing<Refusal extends object, RequestKey extends ChatRequestKey> {
  readonly requestKey: RequestKey;
  /** Which upstream wires this source prefers, in order. A candidate none of whose endpoints
   *  appear here cannot serve the request whatever else it offers. */
  readonly canServe: (candidate: ModelCandidate) => boolean;
  /** What the client's own turn says about where it must go. Client-carried state — a
   *  an OpenAI Responses `previous_response_id`, an encrypted reasoning blob — pins the turn to the
   *  upstream that issued it, so this runs before any candidate is tried. */
  readonly affinity: (payload: Pick<ChatFacts, RequestKey>[RequestKey], gateway: ChatGatewayCtx) => Promise<AffinityRequestAnalysis<unknown>>;
  readonly unsupported: (model: string) => string;
  readonly refuse: (status: number, message: string, reason: ChatRefusal) => Refusal;
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
export const resolveChatCandidates = <Refusal extends object, RequestKey extends ChatRequestKey>(narrowing: ChatNarrowing<Refusal, RequestKey>) => defineStage<
  Slice<'serve.model'> & Pick<ChatFacts, RequestKey>,
  Slice<'serve.model' | 'serve.candidates'> & Pick<ChatFacts, RequestKey> & Pick<ChatFacts, 'request.chat.candidatePayloads'>,
  Slice<'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  Slice<'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'>,
  Slice<'response.usage.billable' | 'response.http.headers' | 'response.http.body' | 'response.http.status'> & Refusal,
  ChatServices
>({
  name: 'resolveChatCandidates',
  through: {
    request: { needs: ['serve.model', narrowing.requestKey], consumes: [], provides: ['serve.candidates', 'request.chat.candidatePayloads'] },
    response: { needs: ['response.usage.billable', 'response.http.headers'], consumes: [], provides: [] },
  },
  return: { provides: ['response.usage.billable', 'response.http.headers', 'response.http.body', 'response.http.status', ...narrowing.refuses] },
  execute: async (facts, next, use) => {
    const model = facts['serve.model'];
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: use.gateway.upstreamIds,
      model,
      kind: 'chat',
      scheduler: use.gateway.backgroundScheduler,
      runtimeLocation: use.gateway.runtimeLocation,
    });

    // An empty billed set is what "we did not call an upstream" looks like, and an empty
    // header list is the same statement on the other key.
    const refuse = (status: number, message: string, reason: ChatRefusal) =>
      move({
        ...facts,
        'response.usage.billable': [],
        'response.http.headers': [],
        'response.http.body': null, 'response.http.status': status,
        ...narrowing.refuse(status, message, reason),
      });

    const affinity = await narrowing.affinity(facts[narrowing.requestKey] as ChatFacts[RequestKey], use.gateway);
    const viable = candidates.filter(candidate => narrowing.canServe(candidate));
    const selection = selectAffinityCandidates(viable, affinity);
    // A turn whose carried state needs two upstreams at once is a request the client can fix
    // by not carrying it, which is what every family called this before: a 400, not a
    // conflict with something the gateway holds.
    if ('kind' in selection) return refuse(400, selection.message, 'routing-unavailable');
    if (selection.candidates.length === 0) {
      const missing = sawModel
        ? narrowing.unsupported(model)
        : `Model ${model} is not available on any configured upstream.`;
      return refuse(sawModel ? 400 : 404, appendFailedUpstreams(missing, failedUpstreams), sawModel ? 'model-unsupported' : 'model-missing');
    }

    const selectors = use.rememberCandidates(selection.candidates);
    // Selection and payload projection are pure after carrier decoding. Snapshot only the
    // accepted candidates' request values; live provider instances remain in the registry.
    const payloads = Object.fromEntries(selectors.map((selector, index) => [
      selector.candidateId, selection.payloadFor(selection.candidates[index]),
    ]));
    await use.log.debug('resolved chat candidates', { model, viable: selection.candidates.length, resolved: candidates.length });
    return await next({ ...facts, 'serve.candidates': move(selectors), 'request.chat.candidatePayloads': move(payloads) });
  },
});
