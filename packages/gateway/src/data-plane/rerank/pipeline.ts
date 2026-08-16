// Rerank as a pipeline. The family with a canonical contract already — parse, render,
// serialize and a usage reading — so it is the one that proves the shared stages on real
// business before the families that need their contracts written first.
//
// The shape every family repeats:
//
//   emitRerank            the edge: serializes the answer into the client's protocol
//   writeSettlement       above the fork, so a run bills once however many attempts it made
//   resolveCandidates     narrows to the upstreams that can serve this request
//   failover              runs what follows once per candidate
//   callRerankUpstream    the ending: dials, and provides what came back

import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity, Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { failover, resolveCandidates } from '../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { defineStage, move, compose } from '@floway-dev/pipeline';
import { parseDecimalString, type RerankProtocol, type RerankSourceProtocol } from '@floway-dev/protocols/common';
import {
  parseRerankResponse,
  parseRerankUsage,
  renderRerankResponse,
  rerankRequestIncompatibility,
  type CanonicalRerankRequest,
  type CanonicalRerankResponse,
} from '@floway-dev/protocols/rerank';
import { providerModelOf } from '@floway-dev/provider';

/** Rerank's own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface RerankFacts extends GatewayFacts {
  /** Which of the four rerank protocols the client spoke. It belongs to the ingress and
   *  stays put: the answer is rendered back into it whatever the upstream spoke. */
  'ingress.rerank.sourceProtocol': RerankSourceProtocol;
  'request.rerank.canonical': CanonicalRerankRequest;
  'response.rerank.canonical': CanonicalRerankResponse | Failure;
  /** Which protocol the upstream turned out to speak. A response fact, because it is not
   *  known until one answered, and the edge needs it to render back into the client's. */
  'response.rerank.targetProtocol': RerankProtocol;
  /** What the client is actually sent, in its own protocol. The edge provides it, so a
   *  dump shows the bytes the client received rather than the gateway's canonical form. */
  'response.rerank.rendered': Record<string, unknown>;
}

type R<K extends keyof RerankFacts> = { [P in K]: RerankFacts[P] };

/**
 * The outermost edge. Renders the canonical answer into the protocol the client spoke —
 * which is why `ingress.rerank.sourceProtocol` is an ingress fact and not a request one:
 * it survives the switch to whatever protocol the upstream turned out to speak.
 */
const emitRerank = defineStage<
  R<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical'>,
  R<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical'>,
  R<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical' | 'response.rerank.canonical' | 'response.rerank.targetProtocol'>,
  R<'response.rerank.rendered'>
>({
  name: 'emitRerank',
  through: {
    request: {
      needs: ['ingress.rerank.sourceProtocol', 'request.rerank.canonical'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.rerank.canonical'],
      consumes: ['response.rerank.canonical', 'response.rerank.targetProtocol'],
      provides: ['response.rerank.rendered'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.rerank.canonical': answer, 'response.rerank.targetProtocol': target, ...rest } = back;
    if (isFailure(answer)) {
      return { ...rest, 'response.rerank.rendered': move({ error: { message: answer.message, type: 'api_error' } }) };
    }
    return {
      ...rest,
      'response.rerank.rendered': move(renderRerankResponse(
        back['ingress.rerank.sourceProtocol'],
        target,
        answer,
        back['request.rerank.canonical'],
      )),
    };
  },
});

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer and
 * what the call is billable for. A failure is a value: a 429 here is what an earlier stage
 * fails over, and even a 400 can be, because the next candidate's path and flags may differ.
 */
const callRerankUpstream = defineStage<
  R<'request.rerank.canonical' | 'route.attempt' | 'ingress.http.headers'>,
  R<'response.rerank.canonical' | 'response.rerank.targetProtocol' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callRerankUpstream',
  return: {
    provides: ['response.rerank.canonical', 'response.rerank.targetProtocol', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const request = facts['request.rerank.canonical'];
    const result = await candidate.provider.instance.callRerank(
      providerModelOf(candidate),
      request,
      use.gateway.abortSignal,
      // The client's own headers reach the upstream from the record, not from a live
      // request object: what a provider is allowed to forward is filtered per provider,
      // and the dump shows what was there to filter.
      buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]) => [name, value]))),
    );
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'rerank');
    const identity = telemetryModelIdentity(candidate, result.modelKey);

    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      return move({
        ...facts,
        'response.rerank.canonical': {
          status: result.response.status,
          message: await result.response.text(),
        },
        'response.rerank.targetProtocol': result.target.protocol,
        // The upstream was called and reported nothing, which is a different situation
        // from reporting zero — so the entity is present with no quantities.
        'response.usage.billable': [{ identity, quantities: {} }],
      });
    }

    // Every protocol the gateway carries is one it fully understands: the body is parsed
    // here and re-serialized at the edge, whether or not the two protocols match.
    const body = await result.response.json() as unknown;
    const canonical = parseRerankResponse(result.target.protocol, body);
    const usage = parseRerankUsage(result.target.protocol, body);
    return move({
      ...facts,
      'response.rerank.canonical': canonical,
      'response.rerank.targetProtocol': result.target.protocol,
      'response.usage.billable': [{
        identity,
        quantities: billed(usage),
        // A rerank rate can depend on how large the input was and not only on how much of
        // it there was, so the token total is a pricing input as well as a quantity.
        ...(usage?.totalTokens === undefined ? {} : { pricingFacts: { inputTokens: usage.totalTokens } }),
      }],
    });
  },
});

const billed = (usage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined): UsageQuantities => {
  const quantities: UsageQuantities = {};
  if (usage?.searchUnits !== undefined) quantities.rerank_searches = parseDecimalString(String(usage.searchUnits));
  if (usage?.totalTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.totalTokens));
  return quantities;
};

/** A candidate that cannot serve *this* request is not a candidate. Saying why is what
 *  turns an empty list into a 400 a client can act on. */
const narrowing = (request: CanonicalRerankRequest) => ({
  kind: 'rerank' as const,
  reject: (candidate: Parameters<typeof providerModelOf>[0]) => {
    const model = providerModelOf(candidate);
    if (candidate.model.endpoints.rerank === undefined || model.rerankTarget === undefined) {
      return 'the upstream does not expose a rerank endpoint';
    }
    return rerankRequestIncompatibility(model.rerankTarget.protocol, request);
  },
  refuse: (status: number, message: string) => ({ 'response.rerank.canonical': { status, message } }),
  refuses: ['response.rerank.canonical'] as const,
});

export const rerankServePipeline = (request: CanonicalRerankRequest): Pipeline<
  R<'ingress.http.headers' | 'ingress.rerank.sourceProtocol' | 'request.rerank.canonical' | 'serve.model'>,
  R<'response.rerank.rendered' | 'response.usage.billable'>
> => compose('rerankServe', [
  emitRerank,
  writeSettlement(handedUp => isFailure((handedUp as { 'response.rerank.canonical'?: unknown })['response.rerank.canonical'])),
  resolveCandidates(narrowing(request)),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.rerank.canonical'?: unknown })['response.rerank.canonical']),
    owns: [],
  }),
  callRerankUpstream,
]);

export type { BillableEntity };
