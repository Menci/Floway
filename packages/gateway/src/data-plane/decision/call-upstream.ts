import type { Fields } from './facts.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity } from '../pipeline/facts.ts';
import { providerEntry } from '../pipeline/provider-entry.ts';
import { providerUsage } from '../pipeline/provider-usage.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { dialFailure, readUpstreamBody, spentBody, unreadableBody } from '../pipeline/upstream-body.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';
import { isJsonObject, parseDecimalString, parseJSONWithRawNumbers, upstreamErrorMessage } from '@floway-dev/protocols/common';
import { parseDecisionUsage } from '@floway-dev/protocols/decision';
import { providerModelOf } from '@floway-dev/provider';
import type { ProviderOperationPayloads, ProviderRequest, ProviderResponse } from '@floway-dev/provider';

/** Decision models are billed on input tokens only, which is also the one pricing input. */
const metered = (usage: { inputTokens?: number }): Pick<BillableEntity, 'quantities' | 'pricingFacts'> => {
  if (usage.inputTokens === undefined) return { quantities: {} };
  const quantities: UsageQuantities = { input_tokens: parseDecimalString(String(usage.inputTokens)) };
  return { quantities, pricingFacts: { inputTokens: usage.inputTokens } };
};

/**
 * The ending. It dials, reads the upstream's body with its numbers kept as their source tokens,
 * and provides the answer and what the call is billable for. A failure is a value, so an
 * earlier stage can fail over it.
 */
export const callDecisionUpstream = defineStage<
  Fields<'request.decision.canonical' | 'route.attempt' | 'ingress.http.headers'>,
  ProviderRequest<ProviderOperationPayloads['decision']>,
  ProviderResponse,
  Fields<'response.decision.answer' | 'response.decision.targetProtocol' | 'response.http.status' | 'response.http.headers' | 'response.http.body' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callDecisionUpstream',
  into: {
    request: { needs: ['request.decision.canonical', 'route.attempt', 'ingress.http.headers'], consumes: [], provides: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'] },
    response: {
      needs: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.http.body'],
      consumes: ['response.http.exchange', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'],
      provides: ['response.decision.answer', 'response.decision.targetProtocol', 'response.http.status', 'response.http.headers', 'response.http.body', 'response.usage.billable'],
    },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // The narrowing kept only candidates whose provider named a dialect, so this holds for
    // every attempt; it is what the request was serialized in and what the answer is read as.
    const target = providerModelOf(candidate).decisionTarget;
    if (target === undefined) {
      throw new Error(`${candidate.provider.upstreamId} serves decision for ${candidate.model.id} without a target dialect`);
    }
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'decision');

    const pipeline = candidate.provider.pipelines.decision;
    if (pipeline === undefined) throw new Error(`Provider ${candidate.provider.kind} has no decision pipeline`);
    const back = await next(providerEntry(facts, candidate, facts['request.decision.canonical']), pipeline);
    const { 'response.http.exchange': exchange, 'response.provider.modelKey': modelKey, 'response.provider.called': wasCalled, 'response.provider.previousCalls': _previousCalls, ...rest } = back;
    if (exchange.type === 'transportFailure') {
      return move({
        ...rest,
        'response.decision.answer': dialFailure(exchange.error),
        'response.decision.targetProtocol': target.protocol,
        'response.http.status': 502,
        'response.http.headers': [],
        'response.usage.billable': providerUsage(candidate, back, []),
      });
    }
    const response = exchangeResponse(exchange);
    const identity = telemetryModelIdentity(candidate, modelKey);
    const headers = [...response.headers];
    spentBody(exchange.body);
    const body = await readUpstreamBody(response, parseJSONWithRawNumbers);
    // The upstream was called and reported nothing, which is a different situation from
    // reporting zero — so the entity is present with no quantities.
    const unreported = wasCalled ? [{ identity, quantities: {} }] : [];

    if (!response.ok) {
      await use.log.warn('upstream refused', { status: response.status });
      return move({
        ...rest,
        'response.decision.answer': {
          status: response.status,
          message: upstreamErrorMessage(body.json) ?? body.text,
          ...('json' in body ? { body: body.json } : {}),
        },
        'response.decision.targetProtocol': target.protocol,
        'response.http.status': response.status,
        'response.http.headers': headers,
        'response.usage.billable': providerUsage(candidate, back, unreported),
      });
    }

    if (!isJsonObject(body.json)) {
      return move({
        ...rest,
        'response.decision.answer': unreadableBody(response, body, 'the decision protocol'),
        'response.decision.targetProtocol': target.protocol,
        'response.http.status': response.status,
        'response.http.headers': headers,
        'response.usage.billable': providerUsage(candidate, back, unreported),
      });
    }

    // A usage block the reader cannot make sense of is a report we cannot parse, which from
    // here is no report; it does not make the answer itself unreadable.
    let usage: { inputTokens?: number };
    try {
      usage = parseDecisionUsage(body.json);
    } catch (error) {
      await use.log.warn('upstream reported usage the decision protocol cannot read', { error: String(error) });
      usage = {};
    }
    return move({
      ...rest,
      'response.decision.answer': { body: body.json },
      'response.decision.targetProtocol': target.protocol,
      'response.http.status': response.status,
      'response.http.headers': headers,
      'response.usage.billable': providerUsage(candidate, back, wasCalled ? [{ identity, ...metered(usage) }] : []),
    });
  },
});
