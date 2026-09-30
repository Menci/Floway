import type { Fields } from './facts.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import type { Failure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { dialFailure, readUpstreamBody, unreadableBody } from '../pipeline/upstream-body.ts';
import { upstreamPerformanceContext, telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { upstreamErrorMessage, parseDecimalString } from '@floway-dev/protocols/common';
import { serializeOpenAIEmbeddingsRequest, parseOpenAIEmbeddingsResponse, type CanonicalOpenAIEmbeddingsResponse, type CanonicalOpenAIEmbeddingsUsage } from '@floway-dev/protocols/openai-embeddings';
import { providerModelOf } from '@floway-dev/provider';

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer and
 * what the call is billable for. A failure is a value: a 429 here is what an earlier stage
 * fails over, and even a 400 can be, because the next candidate's path and flags may differ.
 */
export const callOpenAIEmbeddingsUpstream = defineStage<
  Fields<'request.openaiEmbeddings.canonical' | 'route.attempt' | 'ingress.http.headers' | 'serve.model'>,
  Fields<'response.openaiEmbeddings.canonical' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callOpenAIEmbeddingsUpstream',
  return: {
    provides: ['response.openaiEmbeddings.canonical', 'response.http.status', 'response.http.headers', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'embeddings');

    let result;
    try {
      result = await candidate.provider.instance.callOpenAIEmbeddings(
        providerModelOf(candidate),
        serializeOpenAIEmbeddingsRequest(facts['request.openaiEmbeddings.canonical']),
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
        'response.openaiEmbeddings.canonical': dialFailure(error),
        'response.http.status': 502,
        'response.http.headers': [],
        'response.usage.billable': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // What came back, unfiltered: the edge is where a client's view of it is decided.
    const headers = [...result.response.headers];
    const body = await readUpstreamBody(result.response);
    // The upstream was called and reported nothing, which is a different situation from
    // reporting zero — so the entity is present with no quantities.
    const answered = (canonical: CanonicalOpenAIEmbeddingsResponse | Failure, quantities: UsageQuantities) => move({
      ...facts,
      'response.openaiEmbeddings.canonical': canonical,
      'response.http.status': result.response.status,
      'response.http.headers': headers,
      'response.usage.billable': [{ identity, quantities }],
    });
    const reportedNothing: UsageQuantities = {};

    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      return answered({
        status: result.response.status,
        message: upstreamErrorMessage(body.json) ?? body.text,
        ...('json' in body ? { body: body.json } : {}),
      }, reportedNothing);
    }
    if (!('json' in body)) {
      return answered(unreadableBody(result.response, body, 'the OpenAI Embeddings protocol'), reportedNothing);
    }

    // Every protocol the gateway carries is one it fully understands: the body is parsed
    // here and written again at the edge, in whichever encoding the client can read.
    let canonical: CanonicalOpenAIEmbeddingsResponse;
    try {
      canonical = parseOpenAIEmbeddingsResponse(body.json, facts['serve.model']);
    } catch (error) {
      use.log.warn('upstream answered with a body the OpenAI Embeddings protocol cannot read', { error: String(error) });
      return answered(unreadableBody(result.response, body, 'the OpenAI Embeddings protocol'), reportedNothing);
    }
    return answered(canonical, billed(canonical.usage));
  },
});

// An OpenAI Embeddings call has no output side, so `prompt_tokens` is the whole of what the
// upstream metered and `total_tokens` restates it. An upstream that reported nothing bills
// nothing, and says so by leaving the entity's quantities empty.
const billed = (usage: CanonicalOpenAIEmbeddingsUsage | undefined): UsageQuantities =>
  usage === undefined ? {} : { input_tokens: parseDecimalString(String(usage.promptTokens)) };
