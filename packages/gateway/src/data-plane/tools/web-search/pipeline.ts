import {
  executeOperationToText,
  parseWebSearchOperations,
  renderWebSearchCallOutput,
  runBackendSearchMulti,
  startBatchFetch,
  type SearchResponseLength,
  type WebSearchCallIR,
  type WebSearchFilters,
  type WebSearchOperation,
} from './operations.ts';
import type { ConfiguredWebSearchProvider } from './types.ts';
import { filterInboundHeaderEntries } from '../../pipeline/headers.ts';
import type { GatewayPipelineServices } from '../../pipeline/services.ts';
import { defineStage, dispatch, handoff, pipeline, terminal } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline } from '@floway-dev/pipeline';
import type { HttpOutcome, RouteCandidate } from '@floway-dev/provider';

export interface AlphaSearchPassthroughSubInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': Record<string, unknown>;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
}

export type LocalWebSearchSubInput =
  | {
    readonly kind: 'search-multi';
    readonly queries: readonly string[];
    readonly filters: WebSearchFilters;
    readonly responseLength?: SearchResponseLength;
  }
  | {
    readonly kind: 'op';
    readonly op: WebSearchOperation;
    readonly filters: WebSearchFilters;
    readonly responseLength?: SearchResponseLength;
    readonly includeSearchActionSources: boolean;
  };

export type LocalWebSearchSubOutput = string | WebSearchCallIR;

export interface WebSearchPipelineServices extends GatewayPipelineServices {
  readonly webSearchProvider: () => Promise<ConfiguredWebSearchProvider>;
  readonly pageCache: Map<string, {
    readonly content: string;
    readonly truncated: boolean;
    readonly fullContentBytes: number;
    readonly title?: string;
  }>;
}

export const alphaSearchPassthroughSubPipeline: Pipeline<
  AlphaSearchPassthroughSubInput,
  HttpOutcome,
  GatewayPipelineServices
> = pipeline<AlphaSearchPassthroughSubInput>('gateway.alpha-search.passthrough')
  .end(dispatch<AlphaSearchPassthroughSubInput, HttpOutcome, GatewayPipelineServices>({
    name: 'alpha-search.dispatch',
    select: (facts, env) => {
      const provider = env.providerFor(facts['route.candidate'].upstreamId);
      const target = provider.pipelines?.alphaSearch;
      if (target === undefined) {
        throw new Error(`Provider ${facts['route.candidate'].upstreamId} has no alphaSearch pipeline`);
      }
      return handoff(target, {
        'route.candidate': facts['route.candidate'],
        'provider.model': facts['route.candidate'].providerModel,
        'request.inboundHeaders': filterInboundHeaderEntries(
          facts['request.inboundHeaders'],
          provider.inboundHeaderAllowlist,
        ),
        'request.payload': facts['request.payload'],
      });
    },
  }));

const localWebSearchStage = defineStage<
  LocalWebSearchSubInput,
  { readonly 'web-search.result': LocalWebSearchSubOutput },
  LocalWebSearchSubOutput,
  LocalWebSearchSubOutput,
  never,
  WebSearchPipelineServices
>({
  name: 'web-search.local',
  provides: ['web-search.result'],
  execute: async (facts, next, env) => {
    const session = {
      getProvider: env.webSearchProvider,
      filters: facts.filters,
      apiKeyId: env.apiKeyId,
      pageCache: env.pageCache,
      includeSearchActionSources: facts.kind === 'search-multi' ? true : facts.includeSearchActionSources,
      signal: env.signal,
      ...(facts.responseLength === undefined ? {} : { responseLength: facts.responseLength }),
    };

    if (facts.kind === 'search-multi') {
      const parsed = parseWebSearchOperations({
        search_query: facts.queries.map(query => ({ q: query })),
      });
      if (parsed.kind !== 'ops') throw new Error('invariant broken: synthesized search commands did not parse');
      const searches = parsed.ops.filter((op): op is Extract<WebSearchOperation, { kind: 'search' }> => op.kind === 'search');
      return await next({ 'web-search.result': await runBackendSearchMulti(searches, session) });
    }

    const batch = await startBatchFetch({ kind: 'ops', ops: [facts.op] }, session);
    return await next({
      'web-search.result': await executeOperationToText(facts.op, session, batch),
    });
  },
});

export const localWebSearchSubPipeline: Pipeline<
  LocalWebSearchSubInput,
  LocalWebSearchSubOutput,
  WebSearchPipelineServices
> = pipeline<LocalWebSearchSubInput>('web-search.local')
  .use(localWebSearchStage)
  .end(terminal<
    { readonly 'web-search.result': LocalWebSearchSubOutput },
    LocalWebSearchSubOutput,
    WebSearchPipelineServices
  >({
    name: 'web-search.local.end',
    execute: async facts => facts['web-search.result'],
  }));

export const localWebSearchText = (output: LocalWebSearchSubOutput): string =>
  typeof output === 'string' ? output : renderWebSearchCallOutput(output);
