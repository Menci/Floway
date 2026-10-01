import type { BillableUsage, ProtocolFrame, RerankTarget } from '@floway-dev/protocols/common';
import type { OpenAIResponsesCompactionResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { InternalDebugError, PerformanceTelemetryContext, TelemetryModelIdentity } from '@floway-dev/provider';

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}
export interface ProviderRerankCallResult extends ProviderCallResult { target: RerankTarget }
export type ProviderStreamResult<TEvent> =
  | { ok: true; events: AsyncIterable<ProtocolFrame<TEvent>>; modelKey: string; headers?: Headers }
  | { ok: false; response: Response; modelKey: string };
export type ProviderOpenAIResponsesResult =
  | (ProviderStreamResult<OpenAIResponsesStreamEvent> & { action: 'generate' })
  | { action: 'compact'; ok: true; result: OpenAIResponsesCompactionResult; modelKey: string }
  | { action: 'compact'; ok: false; response: Response; modelKey: string };

export interface EventResultMetadata {
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  billableUsage?: BillableUsage;
}
export interface EventResult<T> {
  type: 'events';
  events: AsyncIterable<T>;
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  headers?: Headers;
}
export type ExecuteResult<T> = EventResult<T>
  | { type: 'api-error'; source: 'upstream' | 'gateway'; status: number; headers: Headers; body: Uint8Array; performance?: PerformanceTelemetryContext; upstreamId?: string }
  | { type: 'internal-error'; status: number; error: InternalDebugError; performance?: PerformanceTelemetryContext };

export const eventResult = <T>(events: AsyncIterable<T>, modelIdentity: TelemetryModelIdentity, options: Omit<EventResult<T>, 'type' | 'events' | 'modelIdentity'> = {}): EventResult<T> => {
  const result: EventResult<T> = { type: 'events', events, modelIdentity };
  if (options.performance !== undefined) result.performance = options.performance;
  if (options.finalMetadata !== undefined) result.finalMetadata = options.finalMetadata;
  if (options.headers !== undefined) result.headers = options.headers;
  return result;
};
