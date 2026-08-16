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
import { dialFailure, readUpstreamBody, unreadableBody } from '../pipeline/upstream-body.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { defineStage, move, compose } from '@floway-dev/pipeline';
import { parseDecimalString, renderErrorEnvelope, upstreamErrorMessage, type RerankProtocol, type RerankSourceProtocol } from '@floway-dev/protocols/common';
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
  /** Which protocol the attempt spoke. A response fact, because an upstream picks the target
   *  it answers in and the edge needs it to render back into the client's — a run that never
   *  reached one carries the target its request was serialized for. */
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
  R<'ingress.rerank.sourceProtocol' | 'request.rerank.canonical' | 'response.rerank.canonical' | 'response.rerank.targetProtocol' | 'response.http.headers'>,
  R<'response.rerank.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitRerank',
  through: {
    request: {
      needs: ['ingress.rerank.sourceProtocol', 'request.rerank.canonical'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.rerank.canonical', 'response.http.headers'],
      consumes: ['response.rerank.canonical', 'response.rerank.targetProtocol', 'response.http.headers'],
      provides: ['response.rerank.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.rerank.canonical': answer, 'response.rerank.targetProtocol': target, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.rerank.rendered': move(renderErrorEnvelope(answer.message, answer.body)),
        // The upstream's own status, or the gateway's own when it refused before dialling.
        // A client is not owed the upstream's exact bytes; it is owed the truth about what
        // happened, and a 429 arriving as a 200 is not that.
        'response.http.status': answer.status,
      };
    }
    // Translating can fail on an answer that parsed: a result may index a document the
    // request never sent. The upstream answered and the gateway cannot put that answer in the
    // protocol the client speaks, which is the gateway failing to serve rather than anything
    // the client can fix — so it is 502, and a value like every other failure here.
    let rendered: Record<string, unknown>;
    try {
      rendered = renderRerankResponse(
        back['ingress.rerank.sourceProtocol'],
        target,
        answer,
        back['request.rerank.canonical'],
      );
    } catch (error) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.rerank.rendered': move(renderErrorEnvelope(error instanceof Error ? error.message : String(error))),
        'response.http.status': 502,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.http.status': 200,
      'response.rerank.rendered': move(rendered),
    };
  },
});

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer and
 * what the call is billable for. A failure is a value: a 429 here is what an earlier stage
 * fails over, and even a 400 can be, because the next candidate's path and flags may differ.
 */
const callRerankUpstream = defineStage<
  R<'request.rerank.canonical' | 'route.attempt' | 'ingress.http.headers' | 'ingress.rerank.sourceProtocol'>,
  R<'response.rerank.canonical' | 'response.rerank.targetProtocol' | 'response.http.headers' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callRerankUpstream',
  return: {
    provides: ['response.rerank.canonical', 'response.rerank.targetProtocol', 'response.http.headers', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const request = facts['request.rerank.canonical'];
    const model = providerModelOf(candidate);
    // Configuration refuses a rerank model without a target, so this holds for every candidate
    // the narrowing kept; saying so here is what lets a dial that never answered still name
    // the protocol it spoke.
    const configuredTarget = model.rerankTarget;
    if (configuredTarget === undefined) {
      throw new Error(`${candidate.provider.upstreamId} serves rerank for ${candidate.model.id} without a target protocol`);
    }
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'rerank');

    let result;
    try {
      result = await candidate.provider.instance.callRerank(
        model,
        request,
        use.gateway.abortSignal,
        // The client's own headers reach the upstream from the record, not from a live
        // request object: what a provider is allowed to forward is filtered per provider,
        // and the dump shows what was there to filter.
        buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]) => [name, value]))),
      );
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so nothing was billed and there are
      // no headers to carry. What it leaves behind is the performance row settlement writes.
      return move({
        ...facts,
        'response.rerank.canonical': dialFailure(error),
        'response.rerank.targetProtocol': configuredTarget.protocol,
        'response.http.headers': [],
        'response.usage.billable': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // What came back, unfiltered: the edge is where a client's view of it is decided.
    const headers = [...result.response.headers];
    const body = await readUpstreamBody(result.response);

    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      return move({
        ...facts,
        'response.rerank.canonical': {
          status: result.response.status,
          message: upstreamErrorMessage(body.json) ?? body.text,
          ...('json' in body ? { body: body.json } : {}),
        },
        'response.rerank.targetProtocol': result.target.protocol,
        'response.http.headers': headers,
        // The upstream was called and reported nothing, which is a different situation
        // from reporting zero — so the entity is present with no quantities.
        'response.usage.billable': [{ identity, quantities: {} }],
      });
    }

    if (!('json' in body)) {
      return move({
        ...facts,
        'response.rerank.canonical': unreadableBody(result.response, body, 'the rerank protocol'),
        'response.rerank.targetProtocol': result.target.protocol,
        'response.http.headers': headers,
        'response.usage.billable': [{ identity, quantities: {} }],
      });
    }

    // A usage block the reader cannot make sense of is a report we cannot parse, which from
    // here is no report. It is read before the results, so an answer this gateway could not
    // model still bills for what the upstream did meter — the two readings are independent
    // and one of them failing is not a reason to discard the other.
    let usage: Pick<CanonicalRerankResponse, 'totalTokens' | 'searchUnits'>;
    try {
      usage = parseRerankUsage(result.target.protocol, body.json);
    } catch (error) {
      use.log.warn('upstream reported usage the rerank protocol cannot read', { error: String(error) });
      usage = {};
    }
    const metered: readonly BillableEntity[] = [{
      identity,
      quantities: billed(usage),
      // A rerank rate can depend on how large the input was and not only on how much of it
      // there was, so the token total is a pricing input as well as a quantity.
      ...(usage.totalTokens === undefined ? {} : { pricingFacts: { inputTokens: usage.totalTokens } }),
    }];

    // An answer the client's own protocol produced is what that client already reads, so the
    // edge renders it back out unchanged and nothing here has to model it. Reading the results
    // is what a *translation* needs, and only a cross-protocol run does one — so a result item
    // this gateway cannot model is a failure there and a field it simply carries here.
    const translating = facts['ingress.rerank.sourceProtocol'] !== result.target.protocol;
    let canonical: CanonicalRerankResponse;
    try {
      canonical = parseRerankResponse(result.target.protocol, body.json);
    } catch (error) {
      if (translating) {
        use.log.warn('upstream answered with results the rerank protocol cannot read', { error: String(error) });
        return move({
          ...facts,
          'response.rerank.canonical': unreadableBody(result.response, body, 'the rerank protocol'),
          'response.rerank.targetProtocol': result.target.protocol,
          'response.http.headers': headers,
          'response.usage.billable': metered,
        });
      }
      use.log.debug('same-protocol answer carries results this gateway does not model', { error: String(error) });
      canonical = { raw: body.json as Record<string, unknown>, results: [] };
    }

    return move({
      ...facts,
      'response.rerank.canonical': canonical,
      'response.rerank.targetProtocol': result.target.protocol,
      'response.http.headers': headers,
      'response.usage.billable': metered,
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
  unsupported: (model: string, reasons: readonly string[]) => reasons.length === 0
    ? `Model ${model} does not support rerank.`
    : `Model ${model} does not support this rerank request: ${reasons.join('; ')}.`,
  refuse: (status: number, message: string) => ({ 'response.rerank.canonical': { status, message } }),
  refuses: ['response.rerank.canonical'] as const,
});

export const rerankServePipeline = (request: CanonicalRerankRequest): Pipeline<
  R<'ingress.http.headers' | 'ingress.rerank.sourceProtocol' | 'request.rerank.canonical' | 'serve.model'>,
  R<'response.rerank.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
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
