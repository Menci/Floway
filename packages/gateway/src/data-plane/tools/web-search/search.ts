import type { WebSearchBackend, WebSearchBackendName, WebSearchBackendRequest, WebSearchBackendResult } from './types.ts';
import { recordWebSearchUsage } from './usage.ts';

export const runWebSearchAndRecordUsage = async (opts: {
  backend: WebSearchBackend;
  backendName: WebSearchBackendName;
  keyId: string;
  request: WebSearchBackendRequest;
}): Promise<WebSearchBackendResult> => {
  try {
    return await opts.backend.search(opts.request);
  } finally {
    // Telemetry must never mask the backend result; log and swallow
    // recording failures.
    try {
      await recordWebSearchUsage({
        backend: opts.backendName,
        keyId: opts.keyId,
        action: 'search',
      });
    } catch (error) {
      console.error('Web search usage record error:', error);
    }
  }
};
