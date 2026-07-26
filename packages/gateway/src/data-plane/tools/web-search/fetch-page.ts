import type { WebSearchFetchPageRequest, WebSearchFetchPageResult, WebSearchProvider, WebSearchProviderName } from './types.ts';
import { recordWebSearchUsage } from './usage.ts';

export const fetchPageAndRecordUsage = async (args: {
  provider: WebSearchProvider;
  providerName: WebSearchProviderName;
  keyId: string;
  request: WebSearchFetchPageRequest;
}): Promise<WebSearchFetchPageResult> => {
  try {
    return await args.provider.fetchPage(args.request);
  } finally {
    // Telemetry must never mask the provider result; log and swallow
    // recording failures.
    try {
      await recordWebSearchUsage({
        provider: args.providerName,
        keyId: args.keyId,
        action: 'fetch_page',
        // Provider billing is per URL; the shim batches multiple URLs into
        // one call to save HTTP round-trips, but each URL must increment
        // its own usage row.
        requests: args.request.urls.length,
      });
    } catch (error) {
      console.error('Web search usage record error:', error);
    }
  }
};
