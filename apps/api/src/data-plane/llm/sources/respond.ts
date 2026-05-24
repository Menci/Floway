import type { TelemetryModelIdentity, TokenUsage } from '../../../repo/types.ts';
import { recordRequestPerformanceForApiKey } from '../../shared/telemetry/performance.ts';
import { hasTokenUsage, recordTokenUsageForApiKey } from '../../shared/telemetry/usage.ts';
import type { RequestContext } from '../interceptors.ts';
import type { EventResultMetadata, ExecuteResult } from '../shared/errors/result.ts';
import type { StreamCompletion } from '../shared/stream/proxy-sse.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface SourceStreamState {
  failed: boolean;
  completed: boolean;
  usage: TokenUsage | null;
}

export const createSourceStreamState = (): SourceStreamState => ({
  failed: false,
  completed: false,
  usage: null,
});

export const rememberSourceFrameUsage = (state: SourceStreamState, usage: TokenUsage | null): void => {
  if (usage && hasTokenUsage(usage)) state.usage = usage;
};

export const recordSourceUsage = async (request: RequestContext, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  if (usage && hasTokenUsage(usage)) await recordTokenUsageForApiKey(request.apiKeyId, modelIdentity, usage);
};

export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ??
    Promise.resolve({
      modelIdentity: result.modelIdentity,
      ...(result.performance ? { performance: result.performance } : {}),
    }));

export const recordSourcePerformance = (request: RequestContext, context: EventResultMetadata['performance'], failed: boolean): void => {
  recordRequestPerformanceForApiKey(request.apiKeyId, request.scheduleBackground, context, failed, performance.now() - request.requestStartedAt);
};

export const sourceStreamFailed = (completion: StreamCompletion, state: SourceStreamState): boolean => completion === 'error' || state.failed || (completion === 'cancel' && !state.completed);
