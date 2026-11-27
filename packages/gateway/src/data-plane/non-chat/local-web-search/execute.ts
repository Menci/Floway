import { defineStage } from './facts.ts';
import { searchAbort, searchSession } from './session.ts';
import {
  executeOperationToIr,
  runBackendSearchMulti,
  startBatchFetch,
} from '../../tools/web-search/operations.ts';
import { runWebSearchAndRecordUsage } from '../../tools/web-search/search.ts';

export const executeLocalWebSearch = defineStage({
  name: 'local-web-search.execute',
  request: { needs: ['http', 'serve.startedAt', 'webSearch'] },
  return: { provides: ['http', 'webSearch'] },
  async execute({ webSearch }, { services: { localWebSearch }, signal }) {
    try {
      signal.throwIfAborted();
      if (webSearch.kind === 'provider') {
        const backend = await localWebSearch.getBackend();
        if (backend.type !== 'enabled') throw new Error('Local web search backend is unavailable after preflight');
        const result = await runWebSearchAndRecordUsage({
          backend: backend.impl,
          backendName: backend.backend,
          keyId: localWebSearch.apiKeyId,
          request: { ...webSearch.query, signal },
        });
        return { http: null, webSearch: { kind: 'provider', result } };
      }

      const { operations, ...options } = webSearch;
      const session = searchSession(localWebSearch, options, signal);
      if (operations.kind === 'multi-search') {
        const result = await runBackendSearchMulti(operations.searches, session);
        return { http: null, webSearch: { kind: 'operations', result } };
      }
      const { operation } = operations;
      const batch = await startBatchFetch({ kind: 'ops', ops: [operation] }, session);
      const result = await executeOperationToIr(operation, session, batch);
      return { http: null, webSearch: { kind: 'operations', result } };
    } catch (cause) {
      return { http: null, webSearch: searchAbort(cause, signal) };
    }
  },
});
