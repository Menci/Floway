// Embeddings as a pipeline. The smallest family there is: one protocol, no translation and
// no stream — so what is left is the four stages every family has, and nothing else.
//
//   emitEmbeddings          the edge: writes the answer in the encoding the client asked for
//   resolveCandidates       narrows to the upstreams that can serve this request
//   failover                runs what follows once per candidate
//   callEmbeddingsUpstream  the ending: dials, and provides what came back
//
// The narrowing is a constant rather than a function of the request, and that is what makes
// this the simple family: an embeddings request carries nothing a candidate could be
// incompatible with, so the only question is whether the upstream exposes the endpoint.

import type { UsageQuantities } from '../../repo/types.ts';
import type { Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { failover, resolveCandidates, type Narrowing } from '../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { compose, defineStage, move } from '@floway-dev/pipeline';
import { parseDecimalString } from '@floway-dev/protocols/common';
import {
  parseEmbeddingsResponse,
  renderEmbeddingsResponse,
  serializeEmbeddingsRequest,
  type CanonicalEmbeddingsRequest,
  type CanonicalEmbeddingsResponse,
  type CanonicalEmbeddingsUsage,
  type EmbeddingsEncodingFormat,
} from '@floway-dev/protocols/embeddings';
import { providerModelOf } from '@floway-dev/provider';

/** Embeddings' own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface EmbeddingsFacts extends GatewayFacts {
  /** Which encoding the client is able to read. It belongs to the ingress and stays put:
   *  the answer is written in it whichever encoding the upstream chose to answer in, and
   *  the two differ whenever an upstream ignores the field. */
  'ingress.embeddings.encodingFormat': EmbeddingsEncodingFormat;
  'request.embeddings.canonical': CanonicalEmbeddingsRequest;
  'response.embeddings.canonical': CanonicalEmbeddingsResponse | Failure;
  /** What the client is actually sent. The edge provides it, so a dump shows the bytes the
   *  client received rather than the gateway's canonical form. */
  'response.embeddings.rendered': Record<string, unknown>;
}

type E<K extends keyof EmbeddingsFacts> = { [P in K]: EmbeddingsFacts[P] };

/**
 * The outermost edge. Writes the vectors in the encoding the client asked for — which is
 * why the encoding is an ingress fact and not a request one: it has to survive an upstream
 * that answered in the other one. A client on an official OpenAI SDK asked for `base64`
 * without its caller choosing to, and will decode as base64 whatever it is handed.
 */
const emitEmbeddings = defineStage<
  E<'ingress.embeddings.encodingFormat'>,
  E<'ingress.embeddings.encodingFormat'>,
  E<'ingress.embeddings.encodingFormat' | 'response.embeddings.canonical'>,
  E<'response.embeddings.rendered' | 'response.http.status'>
>({
  name: 'emitEmbeddings',
  through: {
    request: {
      needs: ['ingress.embeddings.encodingFormat'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.embeddings.canonical'],
      consumes: ['response.embeddings.canonical'],
      provides: ['response.embeddings.rendered', 'response.http.status'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.embeddings.canonical': answer, ...rest } = back;
    if (isFailure(answer)) {
      return {
        ...rest,
        'response.embeddings.rendered': move({ error: { message: answer.message, type: 'api_error' } }),
        // The upstream's own status, or the gateway's own when it refused before dialling.
        // A client is not owed the upstream's exact bytes; it is owed the truth about what
        // happened, and a 429 arriving as a 200 is not that.
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.http.status': 200,
      'response.embeddings.rendered': move(renderEmbeddingsResponse(back['ingress.embeddings.encodingFormat'], answer)),
    };
  },
});

/**
 * The ending. It dials, reads the upstream's body, and provides the canonical answer and
 * what the call is billable for. A failure is a value: a 429 here is what an earlier stage
 * fails over, and even a 400 can be, because the next candidate's path and flags may differ.
 */
const callEmbeddingsUpstream = defineStage<
  E<'request.embeddings.canonical' | 'route.attempt' | 'ingress.http.headers' | 'serve.model'>,
  E<'response.embeddings.canonical' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callEmbeddingsUpstream',
  return: {
    provides: ['response.embeddings.canonical', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const result = await candidate.provider.instance.callEmbeddings(
      providerModelOf(candidate),
      serializeEmbeddingsRequest(facts['request.embeddings.canonical']),
      use.gateway.abortSignal,
      // The client's own headers reach the upstream from the record, not from a live
      // request object: what a provider is allowed to forward is filtered per provider,
      // and the dump shows what was there to filter.
      buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]) => [name, value]))),
    );
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'embeddings');
    const identity = telemetryModelIdentity(candidate, result.modelKey);

    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      return move({
        ...facts,
        'response.embeddings.canonical': {
          status: result.response.status,
          message: await result.response.text(),
        },
        // The upstream was called and reported nothing, which is a different situation
        // from reporting zero — so the entity is present with no quantities.
        'response.usage.billable': [{ identity, quantities: {} }],
      });
    }

    // Every protocol the gateway carries is one it fully understands: the body is parsed
    // here and written again at the edge, in whichever encoding the client can read.
    const canonical = parseEmbeddingsResponse(await result.response.json() as unknown, facts['serve.model']);
    return move({
      ...facts,
      'response.embeddings.canonical': canonical,
      'response.usage.billable': [{ identity, quantities: billed(canonical.usage) }],
    });
  },
});

// An embeddings call has no output side, so `prompt_tokens` is the whole of what the
// upstream metered and `total_tokens` restates it. An upstream that reported nothing bills
// nothing, and says so by leaving the entity's quantities empty.
const billed = (usage: CanonicalEmbeddingsUsage | undefined): UsageQuantities =>
  usage === undefined ? {} : { input_tokens: parseDecimalString(String(usage.promptTokens)) };

/** A candidate that cannot serve *this* request is not a candidate. Saying why is what
 *  turns an empty list into a 400 a client can act on. */
const narrowing: Narrowing<E<'response.embeddings.canonical'>> = {
  kind: 'embedding',
  reject: candidate => candidate.model.endpoints.embeddings === undefined
    ? 'the upstream does not expose an embeddings endpoint'
    : null,
  unsupported: model => `Model ${model} does not support the /embeddings endpoint.`,
  refuse: (status, message) => ({ 'response.embeddings.canonical': { status, message } }),
  refuses: ['response.embeddings.canonical'],
};

export const embeddingsServePipeline: Pipeline<
  E<'ingress.http.headers' | 'ingress.embeddings.encodingFormat' | 'request.embeddings.canonical' | 'serve.model'>,
  E<'response.embeddings.rendered' | 'response.http.status' | 'response.usage.billable'>
> = compose('embeddingsServe', [
  emitEmbeddings,
  writeSettlement(handedUp => isFailure((handedUp as { 'response.embeddings.canonical'?: unknown })['response.embeddings.canonical'])),
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.embeddings.canonical'?: unknown })['response.embeddings.canonical']),
    owns: [],
  }),
  callEmbeddingsUpstream,
]);
