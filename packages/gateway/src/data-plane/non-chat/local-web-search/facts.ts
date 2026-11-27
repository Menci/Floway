import type { LocalWebSearchService } from './services.ts';
import type { SearchResponseLength, WebSearchCallIR, WebSearchFilters, WebSearchOperation } from '../../tools/web-search/operations.ts';
import type { WebSearchBackendRequest, WebSearchBackendResult } from '../../tools/web-search/types.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';

export interface SearchOptions {
  filters: WebSearchFilters;
  includeSearchActionSources: boolean;
  responseLength?: SearchResponseLength;
}

export type WebSearchRequest =
  | { kind: 'provider'; query: Omit<WebSearchBackendRequest, 'signal'> }
  | (SearchOptions & {
    kind: 'operations';
    operations: { kind: 'single'; operation: WebSearchOperation }
      | { kind: 'multi-search'; searches: Extract<WebSearchOperation, { kind: 'search' }>[] };
  });

export interface AlphaSearchBatch extends SearchOptions {
  operations: WebSearchOperation[];
}

export interface SearchAborted {
  kind: 'abort';
  cause: unknown;
}

export type WebSearchResult =
  | SearchAborted
  | { kind: 'provider'; result: WebSearchBackendResult }
  | { kind: 'operations'; result: WebSearchCallIR };

export type AlphaSearchBatchResult = SearchAborted | { kind: 'text'; result: string };

export const { compose, defineStage } = factSpace<{
  http: HttpRequestFact;
  'serve.startedAt': number;
  webSearch: WebSearchRequest;
  alphaSearchBatch: AlphaSearchBatch;
}, {
  http: null;
  webSearch: WebSearchResult;
  alphaSearchBatch: AlphaSearchBatchResult;
}, { localWebSearch: LocalWebSearchService }>();
