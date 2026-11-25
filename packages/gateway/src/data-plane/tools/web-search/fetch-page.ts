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
    await recordWebSearchUsage({
      provider: args.providerName,
      keyId: args.keyId,
      action: 'fetch_page',
      // The shim batches calls, but provider billing is per URL.
      requests: args.request.urls.length,
    });
  }
};
