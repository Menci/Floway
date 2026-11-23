import type { HttpOutput } from './edge-http.ts';
import type { RouteCandidate, GatewayServices } from './services.ts';
import type { TokenUsage, UsageRecord, WebSearchUsageRecord } from '../../repo/types.ts';
import { currentHour } from '../shared/telemetry/hour.ts';
import { performanceRecord } from '../shared/telemetry/performance-record.ts';
import { priceUsageMeasurement, tokenUsageFromBillableUsage, tokenUsageMeasurement, type UsageMeasurement } from '../shared/telemetry/usage.ts';
import { isTransportFailure } from '@floway-dev/http';
import { defineStage, type Deferred, type ErrorSnapshot, type Scope, snapshotError, type StageLogger, type StreamEnd } from '@floway-dev/pipeline';
import type { BillableUsage, PricingRuntimeFacts, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, PerformanceOperation, ProtocolOutcome, ProviderBaseOutput, TelemetryModelIdentity } from '@floway-dev/provider';

export interface BillableCall {
  readonly identity: TelemetryModelIdentity;
  readonly pricingFacts: PricingRuntimeFacts;
  readonly usage: BillableUsage | null;
  readonly observedAt: number;
  readonly disposition: 'completed' | 'stream-error' | 'released' | 'cancelled';
  readonly measurement?: UsageMeasurement;
}

export type ObservedUsage = Pick<BillableCall, 'usage' | 'measurement' | 'pricingFacts'>;

export interface ObservedCallPerformance {
  readonly firstOutputAt: number | null;
  readonly streamEndedAt: number | null;
  readonly upstreamStartedAt: number;
  readonly outputTokens: number;
  readonly failed: boolean;
}

export interface PricedCall extends BillableCall, Readonly<Pick<UsageRecord, 'pricingSelector' | 'metrics'>> {
  readonly dumpTokenUsage: TokenUsage | null;
}

export interface CallUsageFacts { readonly 'response.call.usage': Deferred<BillableCall | null> }
export interface CallPricedFacts { readonly 'response.call.priced': Deferred<PricedCall | null> }
export interface CallPerformanceFacts { readonly 'response.call.performance': Deferred<ObservedCallPerformance | null> }

export interface CallRecordSummary {
  readonly persisted: boolean;
  readonly errors: readonly ErrorSnapshot[];
  readonly upstreamId: string;
  readonly identity: TelemetryModelIdentity | null;
  readonly tokenUsage: TokenUsage | null;
  readonly firstOutputAt: number | null;
  readonly streamEndedAt: number | null;
  readonly upstreamStartedAt: number;
  readonly targetApi: ChatTargetApi | null;
  readonly status: number;
  readonly failed: boolean;
}

export const observedTokenUsage = (usage: BillableUsage | null): ObservedUsage => ({
  usage,
  pricingFacts: usage === null ? {} : {
    serviceTier: usage.tier,
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h,
  },
});

export const observeIdentity = (
  candidate: { readonly modelId: string; readonly upstreamId: string; readonly providerModel: { readonly pricing?: TelemetryModelIdentity['pricing'] } },
  modelKey: string,
): TelemetryModelIdentity => ({
  model: candidate.modelId,
  upstream: candidate.upstreamId,
  modelKey,
  pricing: candidate.providerModel.pricing ?? null,
});

export const billableCall = (scope: Pick<Scope, 'clock'>, identity: TelemetryModelIdentity, disposition: BillableCall['disposition'], usage: ObservedUsage): BillableCall => ({
  ...usage, identity, disposition, observedAt: scope.clock(),
});

export const scalarCallFacts = (
  scope: Pick<Scope, 'defer'>, call: BillableCall | null, performance: ObservedCallPerformance | null,
): CallUsageFacts & CallPerformanceFacts => ({
  'response.call.usage': scope.defer('call.usage', Promise.resolve(call)),
  'response.call.performance': scope.defer('call.performance', Promise.resolve(performance)),
});

interface StreamObserver<Event> {
  readonly frame: (frame: ProtocolFrame<Event>) => { readonly output?: boolean; readonly failed?: boolean; readonly terminal?: boolean } | void;
  readonly usage: () => ObservedUsage;
  readonly complete?: () => boolean;
}

const streamDisposition = (end: StreamEnd, failed: boolean, complete: boolean): BillableCall['disposition'] => {
  if (end.how === 'errored' || end.how === 'leaked' || failed) return 'stream-error';
  if (complete) return 'completed';
  if (end.how === 'exhausted') return 'stream-error';
  return end.how;
};

export const streamPerformance = (
  end: StreamEnd, failed: boolean, complete: boolean, performance: Omit<ObservedCallPerformance, 'failed'>,
): ObservedCallPerformance | null => {
  if (end.how === 'errored' || end.how === 'leaked') return null;
  if (failed || end.how === 'exhausted' || complete) return { ...performance, failed: failed || !complete };
  return null;
};

export const createObserveCall = <OutcomeKey extends string, Event, Result = never>(outcomeKey: OutcomeKey, dialect: {
  readonly open: () => StreamObserver<Event>;
  readonly scalar?: (result: Result) => ObservedUsage;
}) => {
  type Request = { readonly 'route.candidate': Parameters<typeof observeIdentity>[0] };
  type Response = ProviderBaseOutput & Readonly<Record<OutcomeKey, ProtocolOutcome<Event, Result>>>;
  return defineStage<Request, Request, Response, Response & CallUsageFacts & CallPerformanceFacts>({
    name: 'observeCall',
    through: {
      request: { needs: ['route.candidate'], consumes: [], provides: [] },
      response: { needs: ['response.http', 'response.modelKey', outcomeKey], consumes: [], provides: [outcomeKey, 'response.call.usage', 'response.call.performance'] },
    },
    execute: async (request, scope) => {
      const response = await scope.next(request);
      const outcome = response[outcomeKey];
      const upstreamStartedAt = response['response.http'].timing.startedAt;
      if (outcome.kind === 'error') {
        return {
          ...response, ...scalarCallFacts(scope, null, outcome.source === 'upstream'
            ? { firstOutputAt: null, streamEndedAt: null, upstreamStartedAt, outputTokens: 0, failed: true }
            : null),
        };
      }

      const identity = observeIdentity(request['route.candidate'], response['response.modelKey']);
      if (outcome.kind === 'result') {
        const usage = dialect.scalar?.(outcome.result) ?? observedTokenUsage(null);
        return {
          ...response,
          ...scalarCallFacts(scope, billableCall(scope, identity, 'completed', usage), {
            firstOutputAt: null, streamEndedAt: null, upstreamStartedAt, outputTokens: usage.usage?.output ?? 0, failed: false,
          }),
        };
      }

      const observer = dialect.open();
      let firstOutputAt: number | null = null;
      let failed = false;
      let complete = false;
      const observed = scope.wrapStream(outcome.events, {
        label: 'observed upstream events',
        async *transform(source, scope) {
          for await (const frame of source) {
            if (isTransportFailure(frame)) {
              failed = true;
            } else {
              const observation = observer.frame(frame);
              if (observation?.output) firstOutputAt ??= scope.clock();
              failed ||= observation?.failed === true;
              complete ||= frame.type === 'done' || observation?.terminal === true;
            }
            yield frame;
          }
        },
        onClose: end => {
          const usage = observer.usage();
          complete ||= observer.complete?.() === true;
          billing.resolve(billableCall(scope, identity, streamDisposition(end, failed, complete), usage));
          performance.resolve(streamPerformance(end, failed, complete, {
            firstOutputAt, streamEndedAt: scope.clock(), upstreamStartedAt, outputTokens: usage.usage?.output ?? 0,
          }));
        },
      });
      const billing = scope.deferred<BillableCall | null>('call.usage', observed);
      const performance = scope.deferred<ObservedCallPerformance | null>('call.performance', observed);
      return {
        ...response,
        [outcomeKey]: { kind: 'stream', events: observed },
        'response.call.usage': billing.deferred,
        'response.call.performance': performance.deferred,
      };
    },
  });
};

const price = (call: BillableCall): PricedCall => {
  const measurement = call.measurement ?? tokenUsageMeasurement(tokenUsageFromBillableUsage(call.usage ?? undefined));
  const pricing = priceUsageMeasurement(call.identity.pricing, measurement.quantities, call.pricingFacts);
  return { ...call, ...pricing, dumpTokenUsage: measurement.dumpTokenUsage };
};

export const priceCalls = (calls: readonly BillableCall[]): readonly PricedCall[] => calls.map(price);

export const priceCall = defineStage<object, object, CallUsageFacts, CallUsageFacts & CallPricedFacts>({
  name: 'priceCall',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.call.usage'], consumes: [], provides: ['response.call.priced'] },
  },
  execute: async (request, scope) => {
    const response = await scope.next(request);
    return {
      ...response,
      'response.call.priced': scope.defer('call.priced', response['response.call.usage'].promise.then(call => call === null ? null : price(call))),
    };
  },
});

export type SearchUsageReceipt = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

export const persistSearchUsage = async (
  row: WebSearchUsageRecord, store: GatewayServices['searchUsageStore'], log?: Pick<StageLogger, 'error'>,
): Promise<SearchUsageReceipt> => {
  try {
    await store.record(row);
    return { persisted: true };
  } catch (cause) {
    const error = snapshotError(cause);
    console.error('Web search usage record error:', cause);
    log?.error('Web search usage record error:', { action: row.action, error: { ...error } });
    return { persisted: false, error };
  }
};

type RecordServices = Pick<GatewayServices, 'usageStore' | 'performanceStore'>;

interface RecordRequest {
  readonly 'request.auth.apiKeyId': string;
  readonly 'request.route.runtimeLocation': string;
  readonly 'route.candidate': RouteCandidate;
  readonly 'route.targetApi'?: ChatTargetApi;
}

const callKeys = ['response.call.usage', 'response.call.priced', 'response.call.performance'] as const;

export const recordCall = (operation: PerformanceOperation | null) =>
  defineStage<RecordRequest, RecordRequest, HttpOutput & CallUsageFacts & CallPricedFacts & CallPerformanceFacts, HttpOutput, RecordServices>({
    name: 'recordCall',
    through: {
      request: { needs: ['request.auth.apiKeyId', 'request.route.runtimeLocation', 'route.candidate'], consumes: [], provides: [] },
      response: { needs: ['response.http', ...callKeys], consumes: callKeys, provides: [] },
    },
    execute: async (request, scope) => {
      const {
        'response.call.usage': _usage,
        'response.call.priced': priced,
        'response.call.performance': performance,
        ...response
      } = await scope.next(request);
      const candidate = request['route.candidate'];
      const keyId = request['request.auth.apiKeyId'];
      const hour = currentHour();
      const writeUsage = priced.promise.then(async call => {
        if (call === null) return { call, errors: [] };
        try {
          const receipt = await scope.services.usageStore.record({
            keyId, hour, model: call.identity.model, upstream: call.identity.upstream, modelKey: call.identity.modelKey,
            requests: 1, pricingSelector: call.pricingSelector, metrics: call.metrics,
          });
          const errors = [];
          if (receipt.usage !== 'written') {
            scope.log.error('Failed to record usage', { error: { ...receipt.usage.error } });
            errors.push(receipt.usage.error);
          }
          if (receipt.lastUsedAt !== 'written') {
            scope.log.error('Failed to update API key lastUsedAt', { error: { ...receipt.lastUsedAt.error } });
            errors.push(receipt.lastUsedAt.error);
          }
          return { call, errors };
        } catch (cause) {
          const error = snapshotError(cause);
          scope.log.error('Failed to record usage', { error: { ...error } });
          return { call, errors: [error] };
        }
      });
      const writePerformance = performance.promise.then(async observed => {
        if (operation === null || observed === null) return { observed, errors: [] };
        const row = performanceRecord({
          ...observed,
          dimensions: { keyId, hour, model: candidate.modelId, upstream: candidate.upstreamId, operation, runtimeLocation: request['request.route.runtimeLocation'] },
        });
        try {
          await scope.services.performanceStore.record(row);
          return { observed, errors: [] };
        } catch (cause) {
          const error = snapshotError(cause);
          scope.log.warn('Failed to record performance', { error: { ...error } });
          return { observed, errors: [error] };
        }
      });
      scope.defer<CallRecordSummary>('call.record', Promise.all([writeUsage, writePerformance]).then(([usage, performance]) => {
        const { call } = usage;
        const { observed } = performance;
        const errors = [...usage.errors, ...performance.errors];
        return {
          persisted: errors.length === 0,
          errors,
          upstreamId: candidate.upstreamId,
          identity: call?.identity ?? observeIdentity(candidate, candidate.upstreamModelId),
          tokenUsage: call?.dumpTokenUsage ?? null,
          firstOutputAt: observed?.firstOutputAt ?? null,
          streamEndedAt: observed?.streamEndedAt ?? null,
          upstreamStartedAt: response['response.http'].timing.startedAt,
          targetApi: request['route.targetApi'] ?? null,
          status: response['response.http'].status,
          failed: observed?.failed ?? false,
        };
      }));
      return response;
    },
  });
