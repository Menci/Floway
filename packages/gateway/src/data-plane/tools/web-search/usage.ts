import type { WebSearchProviderName } from './types.ts';
import { getRepo } from '../../../repo/index.ts';
import type { WebSearchUsageAction } from '../../../repo/types.ts';
import { currentHour } from '../../shared/telemetry/hour.ts';

export const recordWebSearchUsage = (args: {
  provider: WebSearchProviderName;
  keyId: string;
  action: WebSearchUsageAction;
  requests?: number;
}): Promise<void> => getRepo().webSearchUsage.record({
  provider: args.provider,
  keyId: args.keyId,
  action: args.action,
  hour: currentHour(),
  requests: args.requests ?? 1,
}).catch(error => {
  console.error('Web search usage record error:', error);
});
