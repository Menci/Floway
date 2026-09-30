import type { Fields } from './facts.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { dialFailure, readUpstreamBody, unreadableBody } from '../pipeline/upstream-body.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { upstreamErrorMessage, parseDecimalString } from '@floway-dev/protocols/common';
import { parseRerankUsage, parseRerankResponse, type CanonicalRerankResponse } from '@floway-dev/protocols/rerank';
import { providerModelOf } from '@floway-dev/provider';

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer and
 * what the call is billable for. A failure is a value: a 429 here is what an earlier stage
 * fails over, and even a 400 can be, because the next candidate's path and flags may differ.
 */
export const callRerankUpstream = defineStage<
  Fields<'request.rerank.canonical' | 'route.attempt' | 'ingress.http.headers' | 'ingress.rerank.sourceProtocol'>,
  Fields<'response.rerank.canonical' | 'response.rerank.targetProtocol' | 'response.http.headers' | 'response.usage.billable'>,
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
        buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]))),
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
