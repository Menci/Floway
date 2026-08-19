// OpenAI Embeddings as a pipeline. The smallest family there is: one protocol, no translation
// and no stream — so what is left is the four stages every family has, and nothing else.
//
//   emitOpenAIEmbeddings          the edge: writes the answer in the encoding the client asked
//                                 for
//   resolveCandidates             narrows to the upstreams that can serve this request
//   failover                      runs what follows once per candidate
//   callOpenAIEmbeddingsUpstream  the ending: dials, and provides what came back
//
// The narrowing is a constant rather than a function of the request, and that is what makes
// this the simple family: an OpenAI Embeddings request carries nothing a candidate could be
// incompatible with, so the only question is whether the upstream exposes the endpoint.

import type { UsageQuantities } from '../../repo/types.ts';
import type { Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure, mintedErrorEnvelope, renderFailure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { failover, resolveCandidates, type Narrowing } from '../pipeline/stages.ts';
import { dialFailure, readUpstreamBody, unreadableBody } from '../pipeline/upstream-body.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { compose, defineStage, move } from '@floway-dev/pipeline';
import { parseDecimalString, upstreamErrorMessage } from '@floway-dev/protocols/common';
import {
  parseOpenAIEmbeddingsResponse,
  renderOpenAIEmbeddingsResponse,
  serializeOpenAIEmbeddingsRequest,
  type CanonicalOpenAIEmbeddingsRequest,
  type CanonicalOpenAIEmbeddingsResponse,
  type CanonicalOpenAIEmbeddingsUsage,
  type OpenAIEmbeddingsEncodingFormat,
} from '@floway-dev/protocols/openai-embeddings';
import { providerModelOf } from '@floway-dev/provider';

/** OpenAI Embeddings' own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface OpenAIEmbeddingsFacts extends GatewayFacts {
  /** Which encoding the client is able to read. It belongs to the ingress and stays put:
   *  the answer is written in it whichever encoding the upstream chose to answer in, and
   *  the two differ whenever an upstream ignores the field. */
  'ingress.openaiEmbeddings.encodingFormat': OpenAIEmbeddingsEncodingFormat;
  'request.openaiEmbeddings.canonical': CanonicalOpenAIEmbeddingsRequest;
  'response.openaiEmbeddings.canonical': CanonicalOpenAIEmbeddingsResponse | Failure;
  /** What the client is actually sent. The edge provides it, so a dump shows the bytes the
   *  client received rather than the gateway's canonical form. */
  'response.openaiEmbeddings.rendered': Record<string, unknown>;
}

type E<K extends keyof OpenAIEmbeddingsFacts> = { [P in K]: OpenAIEmbeddingsFacts[P] };

/**
 * The outermost edge. Writes the vectors in the encoding the client asked for — which is
 * why the encoding is an ingress fact and not a request one: it has to survive an upstream
 * that answered in the other one. A client on an official OpenAI SDK asked for `base64`
 * without its caller choosing to, and will decode as base64 whatever it is handed.
 */
const emitOpenAIEmbeddings = defineStage<
  E<'ingress.openaiEmbeddings.encodingFormat'>,
  E<'ingress.openaiEmbeddings.encodingFormat'>,
  E<'ingress.openaiEmbeddings.encodingFormat' | 'response.openaiEmbeddings.canonical' | 'response.http.headers'>,
  E<'response.openaiEmbeddings.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitOpenAIEmbeddings',
  through: {
    request: {
      needs: ['ingress.openaiEmbeddings.encodingFormat'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.openaiEmbeddings.canonical', 'response.http.headers'],
      consumes: ['response.openaiEmbeddings.canonical', 'response.http.headers'],
      provides: ['response.openaiEmbeddings.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.openaiEmbeddings.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);
    if (isFailure(answer)) {
      const failure = renderFailure(answer, mintedErrorEnvelope);
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.openaiEmbeddings.rendered': move(failure.body),
        // The upstream's own status, or the gateway's own when it refused before dialling.
        // A client is not owed the upstream's exact bytes; it is owed the truth about what
        // happened, and a 429 arriving as a 200 is not that.
        'response.http.status': failure.status,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.http.status': 200,
      'response.openaiEmbeddings.rendered': move(renderOpenAIEmbeddingsResponse(back['ingress.openaiEmbeddings.encodingFormat'], answer)),
    };
  },
});

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer and
 * what the call is billable for. A failure is a value: a 429 here is what an earlier stage
 * fails over, and even a 400 can be, because the next candidate's path and flags may differ.
 */
const callOpenAIEmbeddingsUpstream = defineStage<
  E<'request.openaiEmbeddings.canonical' | 'route.attempt' | 'ingress.http.headers' | 'serve.model'>,
  E<'response.openaiEmbeddings.canonical' | 'response.http.headers' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callOpenAIEmbeddingsUpstream',
  return: {
    provides: ['response.openaiEmbeddings.canonical', 'response.http.headers', 'response.usage.billable'],
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

/** A candidate that cannot serve *this* request is not a candidate. Saying why is what
 *  turns an empty list into a 400 a client can act on. */
const narrowing: Narrowing<E<'response.openaiEmbeddings.canonical'>> = {
  kind: 'embedding',
  reject: candidate => candidate.model.endpoints.openaiEmbeddings === undefined
    ? 'the upstream does not expose an OpenAI Embeddings endpoint'
    : null,
  unsupported: model => `Model ${model} does not support the /embeddings endpoint.`,
  refuse: (status, message) => ({ 'response.openaiEmbeddings.canonical': { status, message } }),
  refuses: ['response.openaiEmbeddings.canonical'],
};

export const openaiEmbeddingsServePipeline: Pipeline<
  E<'ingress.http.headers' | 'ingress.openaiEmbeddings.encodingFormat' | 'request.openaiEmbeddings.canonical' | 'serve.model'>,
  E<'response.openaiEmbeddings.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> = compose('openaiEmbeddingsServe', [
  emitOpenAIEmbeddings,
  writeSettlement(handedUp => isFailure((handedUp as { 'response.openaiEmbeddings.canonical'?: unknown })['response.openaiEmbeddings.canonical'])),
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.openaiEmbeddings.canonical'?: unknown })['response.openaiEmbeddings.canonical']),
    owns: [],
  }),
  callOpenAIEmbeddingsUpstream,
]);
