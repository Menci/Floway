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
    // Telemetry must never mask the provider result; log and swallow
    // recording failures.
    try {
      await recordWebSearchUsage({
        provider: opts.providerName,
        keyId: opts.keyId,
        action: 'search',
      });
    } catch (error) {
      console.error('Web search usage record error:', error);
    }
  }
};
