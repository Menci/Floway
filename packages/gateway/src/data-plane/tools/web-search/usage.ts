import type { WebSearchProviderName } from './types.ts';
import { getRepo } from '../../../repo/index.ts';
import type { SearchUsageAction } from '../../../repo/types.ts';
import { currentHour } from '../../shared/telemetry/hour.ts';

// Records a single usage row. Hour is computed at write time; `requests`
// defaults to 1. Throws if the repo write fails — callers wrap this in
// try/catch to swallow telemetry failures without masking the underlying
// provider result.
export const recordSearchUsage = (args: {
  provider: WebSearchProviderName;
  keyId: string;
  action: SearchUsageAction;
  requests?: number;
}): Promise<void> => getRepo().searchUsage.record({
  provider: args.provider,
  keyId: args.keyId,
  action: args.action,
  hour: currentHour(),
  requests: args.requests ?? 1,
});

export const queryWebSearchUsage = (opts: { provider?: WebSearchProviderName; keyId?: string; action?: SearchUsageAction; start: string; end: string }) => getRepo().searchUsage.query(opts);
