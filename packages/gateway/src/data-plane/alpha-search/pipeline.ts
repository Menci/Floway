// Search as a pipeline. The family with no upstream model and no candidate list: by default
// it runs the request's commands here, through the configured search backend, and when the
// operator has pinned a Codex or Custom upstream it asks that upstream's own search endpoint
// instead.
//
// That is an ending, not a missing family. What this shares with the other families is the
// edge; what varies is where the chain stops:
//
//   emitAlphaSearch          the edge: serializes the answer into Codex's protocol
//   parseSearchOperations    local only: Codex's commands become the gateway's own
//   executeSearchOperations  the local ending: runs them, and provides the answer
//   callSearchUpstream       the pinned ending: dials, and provides what came back
//
// `resolveCandidates` and `failover` have nothing to range over here. Local execution reaches
// no upstream at all, and the pinned mode names exactly one upstream and one model in
// operator configuration, so a run is its own only attempt.

import {
  parseAlphaSearchResponse,
  renderAlphaSearchResponse,
  webSearchFiltersFromSettings,
  type AlphaSearchRequest,
  type AlphaSearchResponse,
} from './protocol.ts';
import { isJsonObject } from '../../shared/json-helpers.ts';
import type { Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { filterInboundHeadersForProvider } from '../shared/inbound-headers.ts';
import { telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import {
  assertLocalWebSearchSupport,
  executeOperationToText,
  parseWebSearchOperations,
  startBatchFetch,
  UnsupportedLocalWebSearchFeatureError,
  type WebSearchExecutionSession,
  type WebSearchFilters,
  type WebSearchOperation,
} from '../tools/web-search/operations.ts';
import type { ConfiguredWebSearchProvider } from '../tools/web-search/types.ts';
import type { Pipeline } from '@floway-dev/pipeline';
import { compose, defineStage, move } from '@floway-dev/pipeline';
import { identityWrapUpstreamCall, providerModelOf, type ModelCandidate } from '@floway-dev/provider';

/** Search's own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface SearchFacts extends GatewayFacts {
  'request.search.alphaSearch': AlphaSearchRequest;
  /** What Codex's commands mean to this gateway. Local execution runs on these and never
   *  reads Codex's request again, which is why the stage that provides them consumes it. */
  'request.search.operations': readonly WebSearchOperation[];
  'request.search.filters': WebSearchFilters;
  'response.search.alphaSearch': AlphaSearchResponse | Failure;
  /** What the client is actually sent, in Codex's protocol. The edge provides it, so a dump
   *  shows the bytes the client received rather than the gateway's own form. */
  'response.search.rendered': Record<string, unknown>;
}

type S<K extends keyof SearchFacts> = { [P in K]: SearchFacts[P] };

/** The configured search backend is reached through a resolver rather than a fact: it holds
 *  live handles, and the operator's provider credential is what builds one — so nothing about
 *  it is dumpable and none of it belongs in the record. */
export interface SearchServices extends GatewayServices {
  readonly searchProvider: () => Promise<ConfiguredWebSearchProvider>;
}

/**
 * The outermost edge. Renders the answer into Codex's protocol and says what status the
 * client is owed — the one thing a failure value carries that a rendered body cannot.
 *
 * It declares needing `response.usage.billable` without reading it, which is this family's
 * statement that every path accounts for usage: assembly then rejects an ending, or a
 * short-circuit, that does not provide it.
 */
const emitAlphaSearch = defineStage<
  S<never>,
  S<never>,
  S<'response.search.alphaSearch' | 'response.usage.billable'>,
  S<'response.search.rendered' | 'response.http.status'>
>({
  name: 'emitAlphaSearch',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.search.alphaSearch', 'response.usage.billable'],
      consumes: ['response.search.alphaSearch'],
      provides: ['response.search.rendered', 'response.http.status'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.search.alphaSearch': answer, ...rest } = back;
    if (isFailure(answer)) {
      // An upstream error body is JSON like any other: it was parsed below and is serialized
      // again here. A body that was not an object is one this protocol cannot carry, so what
      // goes out instead is the gateway's own envelope.
      return {
        ...rest,
        'response.search.rendered': move(isJsonObject(answer.body)
          ? answer.body
          : { error: { message: answer.message, type: 'api_error' } }),
        'response.http.status': answer.status,
      };
    }
    return {
      ...rest,
      'response.search.rendered': move(renderAlphaSearchResponse(answer)),
      'response.http.status': 200,
    };
  },
});

/** Both in-band answers a local run can give: Codex reads `output`, so a command it asked for
 *  and this gateway cannot run is text the model sees rather than an HTTP failure. */
const inBandOutput = (facts: S<'request.search.alphaSearch'>, output: string) => move({
  ...facts,
  'response.search.alphaSearch': { encryptedOutput: null, output },
  'response.usage.billable': [],
});

/**
 * Codex's commands become the gateway's own operations, and its settings become the filters
 * they run under. Nothing below reads Codex's request afterwards, so it is consumed here and
 * assembly is what holds that: a stage placed under this one cannot need it back.
 */
const parseSearchOperations = defineStage<
  S<'request.search.alphaSearch'>,
  S<'request.search.operations' | 'request.search.filters'>,
  S<'response.search.alphaSearch' | 'response.usage.billable'>,
  S<'response.search.alphaSearch' | 'response.usage.billable'>,
  S<'response.search.alphaSearch' | 'response.usage.billable'>
>({
  name: 'parseSearchOperations',
  through: {
    request: {
      needs: ['request.search.alphaSearch'],
      consumes: ['request.search.alphaSearch'],
      provides: ['request.search.operations', 'request.search.filters'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable'] },
  execute: async (facts, next) => {
    const { 'request.search.alphaSearch': request, ...rest } = facts;
    const commands = request.commands ?? {};

    try {
      assertLocalWebSearchSupport(commands);
    } catch (error) {
      if (!(error instanceof UnsupportedLocalWebSearchFeatureError)) throw error;
      return inBandOutput(facts, error.message);
    }

    const parsed = parseWebSearchOperations(commands);
    if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
      return inBandOutput(facts, 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.');
    }

    return await next({
      ...rest,
      'request.search.operations': move(parsed.ops),
      'request.search.filters': move(webSearchFiltersFromSettings(request.settings)),
    });
  },
});

/**
 * The local ending. Runs every operation against the configured backend and provides the
 * answer plus what the run is billable for — which is nothing, because no upstream model was
 * called. What the search backend itself charges is accounted per api key by the operations
 * as they run, in units no model prices.
 */
const executeSearchOperations = defineStage<
  S<'request.search.operations' | 'request.search.filters'>,
  S<'response.search.alphaSearch' | 'response.usage.billable'>,
  SearchServices
>({
  name: 'executeSearchOperations',
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable'] },
  execute: async (facts, use) => {
    const session: WebSearchExecutionSession = {
      getProvider: use.searchProvider,
      filters: facts['request.search.filters'],
      apiKeyId: use.gateway.apiKeyId,
      pageCache: new Map(),
      // Codex renders `output` as plain text; the search-action sources list is a Responses
      // protocol concern with no place here.
      includeSearchActionSources: false,
      ...(use.gateway.abortSignal === undefined ? {} : { signal: use.gateway.abortSignal }),
    };

    // One batched fetchPage covers every open and find URL; each operation then renders its
    // own text block, in the parser's canonical order — search_query, open, find, preserving
    // array order within each command kind.
    const ops = [...facts['request.search.operations']];
    const batch = await startBatchFetch({ kind: 'ops', ops }, session);
    const blocks = await Promise.all(ops.map(op => executeOperationToText(op, session, batch)));
    use.log.debug('ran the search operations', { operations: ops.length });

    return move({
      ...facts,
      'response.search.alphaSearch': { encryptedOutput: null, output: blocks.join('\n\n') },
      'response.usage.billable': [],
    });
  },
});

/** The operator's pinned search upstream. One upstream and one model, both from
 *  configuration, which is why nothing here narrows a candidate list. */
export interface PinnedSearchUpstream {
  readonly kind: 'upstream';
  readonly upstreamId: string;
  readonly model: string;
}

/**
 * A misconfigured pin is the operator's to see with its stack, the way the gateway surfaces
 * any internal failure. It is not a failure value: a failure value exists so an earlier stage
 * can fail over it, and there is no earlier stage here with anywhere to go.
 */
const resolvePinnedUpstream = async (pinned: PinnedSearchUpstream, gateway: GatewayCtx): Promise<ModelCandidate> => {
  if (gateway.upstreamIds !== null && !gateway.upstreamIds.includes(pinned.upstreamId)) {
    throw new Error('Selected OpenAI search upstream is outside this API key scope');
  }
  const { candidates } = await enumerateModelCandidates({
    upstreamIds: [pinned.upstreamId],
    model: pinned.model,
    kind: 'chat',
    scheduler: gateway.backgroundScheduler,
    runtimeLocation: gateway.runtimeLocation,
  });
  const candidate = candidates.find(value => value.provider.upstreamId === pinned.upstreamId);
  if (candidate === undefined) {
    throw new Error(`Selected OpenAI search model ${pinned.model} is unavailable`);
  }
  if (candidate.provider.kind !== 'codex' && candidate.provider.kind !== 'custom') {
    throw new Error('Selected upstream does not support OpenAI search passthrough');
  }
  return candidate;
};

/** Codex projects one per-turn metadata snapshot onto several surfaces, and `SearchRequest`
 *  carries no field for it — so on this endpoint the header is the whole of that surface, and
 *  it is the only inbound header this call reads.
 *  https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29 */
const turnMetadataHeaders = (ingress: readonly (readonly [string, string])[]): Headers => {
  const headers = new Headers();
  const metadata = ingress.find(([name]) => name.toLowerCase() === 'x-codex-turn-metadata');
  if (metadata !== undefined) headers.set('x-codex-turn-metadata', metadata[1]);
  return headers;
};

/** The body as JSON, or nothing when it was not JSON at all. Which of the two happened is
 *  what the caller reports; here it is only the question being asked. */
const asJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The pinned ending. Dials the operator's search upstream and provides what came back plus
 * what the call is billable for. A failure is a value here as everywhere, even though this
 * family has nothing that fails over it: the edge is what turns one into a status and a body.
 */
const callSearchUpstream = (pinned: PinnedSearchUpstream) => defineStage<
  S<'request.search.alphaSearch' | 'ingress.http.headers'>,
  S<'response.search.alphaSearch' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callSearchUpstream',
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable'] },
  execute: async (facts, use) => {
    const candidate = await resolvePinnedUpstream(pinned, use.gateway);
    // The caller's model is dropped: this endpoint is pinned to the operator's model, and the
    // provider stamps that one on the way out.
    const { model: _named, ...request } = facts['request.search.alphaSearch'];
    const result = await candidate.provider.instance.callAlphaSearch(
      providerModelOf(candidate),
      request,
      use.gateway.abortSignal,
      {
        fetcher: candidate.fetcher,
        waitUntil: use.gateway.backgroundScheduler,
        // The client's own headers reach the upstream from the record, not from a live
        // request object: what a provider is allowed to forward is filtered per provider,
        // and the dump shows what was there to filter.
        headers: filterInboundHeadersForProvider(turnMetadataHeaders(facts['ingress.http.headers']), candidate.provider),
        // No `PerformanceOperation` names search, so there is no performance row for a
        // stamping wrapper's interval to land on.
        wrapUpstreamCall: identityWrapUpstreamCall,
      },
    );
    // The alpha-search protocol reports no usage at all, so the entity is present with no
    // quantities — the upstream was called and reported nothing, which is a different
    // situation from reporting zero.
    const billable = [{ identity: telemetryModelIdentity(candidate, result.modelKey), quantities: {} }];

    // Every protocol the gateway carries is one it fully understands: the body is read here
    // and serialized again at the edge, an error body included.
    const raw = await result.response.text();
    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      // The message is what came back as text and the body is the same thing parsed: a dump
      // reader gets the upstream's own words either way, and only the parsed form is
      // something the edge can serialize back out.
      const body = asJson(raw);
      return move({
        ...facts,
        'response.search.alphaSearch': {
          status: result.response.status,
          message: raw,
          ...(body === undefined ? {} : { body }),
        },
        'response.usage.billable': billable,
      });
    }

    const verdict = parseAlphaSearchResponse(asJson(raw));
    if (!verdict.ok) {
      // A protocol that requires JSON and receives something else synthesizes its own error,
      // which is also why the raw text rides along: a dump reader is owed what came back.
      return move({
        ...facts,
        'response.search.alphaSearch': {
          status: 502,
          message: `The search upstream answered ${result.response.status} but not in the search protocol: ${verdict.reason}.`,
          body: raw,
        },
        'response.usage.billable': billable,
      });
    }
    return move({ ...facts, 'response.search.alphaSearch': verdict.response, 'response.usage.billable': billable });
  },
});

/** Which ending the chain gets. `upstream` is the operator's `passthroughOpenAiSearch`
 *  setting: the word there is about whose search results the client is given, not about
 *  carrying a protocol the gateway has not parsed. */
export type SearchExecution = { readonly kind: 'local' } | PinnedSearchUpstream;

export const searchServePipeline = (execution: SearchExecution): Pipeline<
  S<'request.search.alphaSearch'>,
  S<'response.search.rendered' | 'response.http.status' | 'response.usage.billable'>
> => compose('searchServe', [
  emitAlphaSearch,
  ...(execution.kind === 'local'
    ? [parseSearchOperations, executeSearchOperations]
    : [callSearchUpstream(execution)]),
]);
