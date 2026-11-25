import type { WebSearchProvider, WebSearchProviderName, WebSearchProviderRequest, WebSearchProviderResult } from './types.ts';
import { recordWebSearchUsage } from './usage.ts';

export const runWebSearchAndRecordUsage = async (opts: {
  provider: WebSearchProvider;
  providerName: WebSearchProviderName;
  keyId: string;
  request: WebSearchProviderRequest;
}): Promise<WebSearchProviderResult> => {
  try {
    return await opts.provider.search(opts.request);
  } finally {
    await recordWebSearchUsage({
      provider: opts.providerName,
      keyId: opts.keyId,
      action: 'search',
    });
  }
};
