import type { WebSearchFetchPageRequest, WebSearchFetchPageResult, WebSearchBackend, WebSearchBackendName } from './types.ts';
import { recordWebSearchUsage } from './usage.ts';

export const fetchPageAndRecordUsage = async (args: {
  backend: WebSearchBackend;
  backendName: WebSearchBackendName;
  keyId: string;
  request: WebSearchFetchPageRequest;
}): Promise<WebSearchFetchPageResult> => {
  try {
    return await args.backend.fetchPage(args.request);
  } finally {
    // Telemetry must never mask the backend result; log and swallow
    // recording failures.
    try {
      await recordWebSearchUsage({
        backend: args.backendName,
        keyId: args.keyId,
        action: 'fetch_page',
        // Backend billing is per URL; the shim batches multiple URLs into
        // one call to save HTTP round-trips, but each URL must increment
        // its own usage row.
        requests: args.request.urls.length,
      });
    } catch (error) {
      console.error('Web search usage record error:', error);
    }
  }
};
