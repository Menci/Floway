import type { Fields } from './facts.ts';
import type { SearchServices } from './services.ts';
import { startBatchFetch, executeOperationToText, type WebSearchExecutionSession } from '../tools/web-search/operations.ts';
import { defineStage, move } from '@floway-dev/pipeline';

/**
 * The local ending. Runs every operation against the configured backend and provides the
 * answer plus what the run is billable for — which is nothing, because no upstream model was
 * called. What the search backend itself charges is accounted per api key by the operations
 * as they run, in units no model prices.
 */
export const executeSearchOperations = defineStage<
  Fields<'request.search.operations' | 'request.search.filters'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers'>,
  SearchServices
>({
  name: 'executeSearchOperations',
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable', 'response.http.headers'] },
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
      // Nothing was called, so there are no upstream headers to carry.
      'response.http.headers': [],
    });
  },
});
