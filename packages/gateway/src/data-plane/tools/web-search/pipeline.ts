import { loadWebSearchConfig } from './config.ts';
import {
  executeOperationToIr,
  runBackendSearchMulti,
  startBatchFetch,
  type SearchResponseLength,
  type WebSearchCallIR,
  type WebSearchExecutionSession,
  type WebSearchFilters,
  type WebSearchOperation,
} from './operations.ts';
import { resolveConfiguredWebSearchProvider } from './provider.ts';
import { runWebSearchAndRecordUsage } from './search.ts';
import type { ConfiguredWebSearchProvider, WebSearchConfig, WebSearchProviderRequest, WebSearchProviderResult } from './types.ts';
import { isCausedBy } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';

type SearchOperation = Extract<WebSearchOperation, { kind: 'search' }>;
type PageCache = WebSearchExecutionSession['pageCache'];
type Page = PageCache extends Map<string, infer Value> ? Value : never;

const MAX_CACHED_PAGES = 64;

class BoundedPageCache extends Map<string, Page> {
  override set(url: string, page: Page): this {
    this.delete(url);
    if (this.size === MAX_CACHED_PAGES) {
      const oldest = this.keys().next();
      if (!oldest.done) this.delete(oldest.value);
    }
    return super.set(url, page);
  }
}

export interface LocalWebSearchService {
  passthroughConfiguration(): Promise<Readonly<WebSearchConfig['passthroughOpenAiSearch']>>;
  getProvider(): Promise<ConfiguredWebSearchProvider>;
  pageCache: PageCache;
}

export const createLocalWebSearchService = (): LocalWebSearchService => {
  let config: Promise<WebSearchConfig> | undefined;
  let provider: Promise<ConfiguredWebSearchProvider> | undefined;
  const configuration = () => config ??= loadWebSearchConfig();
  return {
    passthroughConfiguration: async () => (await configuration()).passthroughOpenAiSearch,
    getProvider: () => provider ??= configuration().then(resolveConfiguredWebSearchProvider),
    pageCache: new BoundedPageCache(),
  };
};

type LocalWebSearchRequest =
  | { kind: 'provider'; query: Omit<WebSearchProviderRequest, 'signal'> }
  | {
    kind: 'operations';
    operations: { kind: 'single'; operation: WebSearchOperation }
      | { kind: 'multi-search'; searches: SearchOperation[] }
      | { kind: 'batch'; operations: WebSearchOperation[] };
    filters: WebSearchFilters;
    includeSearchActionSources: boolean;
    responseLength?: SearchResponseLength;
  };

type LocalWebSearchResponse =
  | { kind: 'abort'; cause: unknown }
  | { kind: 'provider'; result: WebSearchProviderResult }
  | { kind: 'operations'; result: WebSearchCallIR }
  | { kind: 'batch'; result: WebSearchCallIR[] };

interface LocalWebSearchFacts {
  'request.auth.apiKeyId': string;
  'request.webSearch': LocalWebSearchRequest;
  'response.webSearch': LocalWebSearchResponse;
}

const { compose, defineStage } = factSpace<LocalWebSearchFacts, { localWebSearch: LocalWebSearchService }>();
const requestKeys = ['request.webSearch', 'request.auth.apiKeyId'] as const;
const responseKeys = ['response.webSearch'] as const;

const executeLocalWebSearch = defineStage({
  name: 'web-search.execute',
  request: { needs: requestKeys },
  return: { provides: responseKeys },
  async execute(facts, scope) {
    const request = facts['request.webSearch'];
    const keyId = facts['request.auth.apiKeyId'];
    const { getProvider, pageCache } = scope.services.localWebSearch;
    try {
      scope.signal.throwIfAborted();
      if (request.kind === 'provider') {
        const configured = await getProvider();
        if (configured.type !== 'enabled') throw new Error('Local web search provider is unavailable after preflight');
        const result = await runWebSearchAndRecordUsage({
          provider: configured.impl,
          providerName: configured.provider,
          keyId,
          request: { ...request.query, signal: scope.signal },
        });
        return { 'response.webSearch': { kind: 'provider', result } };
      }

      const session: WebSearchExecutionSession = {
        apiKeyId: keyId,
        getProvider,
        pageCache,
        filters: request.filters,
        includeSearchActionSources: request.includeSearchActionSources,
        signal: scope.signal,
        ...(request.responseLength === undefined ? {} : { responseLength: request.responseLength }),
      };
      if (request.operations.kind === 'batch') {
        const { operations } = request.operations;
        const batch = await startBatchFetch({ kind: 'ops', ops: operations }, session);
        const result = await Promise.all(operations.map(operation => executeOperationToIr(operation, session, batch)));
        return { 'response.webSearch': { kind: 'batch', result } };
      }

      const result = request.operations.kind === 'multi-search'
        ? await runBackendSearchMulti(request.operations.searches, session)
        : await executeOperationToIr(
            request.operations.operation,
            session,
            await startBatchFetch({ kind: 'ops', ops: [request.operations.operation] }, session),
          );
      return { 'response.webSearch': { kind: 'operations', result } };
    } catch (cause) {
      if (!isCausedBy(cause, scope.signal.reason)) throw cause;
      return { 'response.webSearch': { kind: 'abort', cause: scope.signal.reason } };
    }
  },
});

export const localWebSearch = compose('web-search', {
  entry: requestKeys,
  exit: responseKeys,
  stages: [],
  ending: executeLocalWebSearch,
});
