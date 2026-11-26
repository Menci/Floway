import type { WebSearchBackendName } from './types.ts';
import { getRepo } from '../../../repo/index.ts';
import type { WebSearchUsageAction } from '../../../repo/types.ts';
import { currentHour } from '../../shared/telemetry/hour.ts';

// Records a single usage row. Hour is computed at write time; `requests`
// defaults to 1. Throws if the repo write fails — callers wrap this in
// try/catch to swallow telemetry failures without masking the underlying
// backend result.
export const recordWebSearchUsage = (args: {
  backend: WebSearchBackendName;
  keyId: string;
  action: WebSearchUsageAction;
  requests?: number;
}): Promise<void> => getRepo().webSearchUsage.record({
  backend: args.backend,
  keyId: args.keyId,
  action: args.action,
  hour: currentHour(),
  requests: args.requests ?? 1,
});
