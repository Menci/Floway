import type { AnswerFacts } from './answer.ts';
import type { HttpDeliveryFacts, HttpOutput } from './edge-http.ts';
import type { SelectedAttemptResponse } from './failover.ts';
import type { BillableCall, UsageFacts } from './observe-usage.ts';
import type { RenderFacts } from './render.ts';
import type { GatewayRouteFacts, GatewayServices, UsageWriteReceipt } from './services.ts';
import type { TokenUsage, UsageRecord, WebSearchUsageRecord } from '../../repo/types.ts';
import { currentHour } from '../shared/telemetry/hour.ts';
import { performanceRecord } from '../shared/telemetry/performance-record.ts';
import { priceUsageMeasurement, tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../shared/telemetry/usage.ts';
import { defineStage, type Deferred, type ErrorSnapshot, snapshotError, type StageLogger } from '@floway-dev/pipeline';
import type { ChatTargetApi, PerformanceOperation, TelemetryModelIdentity } from '@floway-dev/provider';

interface PricedCall extends BillableCall, Readonly<Pick<UsageRecord, 'pricingSelector' | 'metrics'>> {
  readonly dumpTokenUsage: TokenUsage | null;
}

interface PricedUsageFacts {
  readonly 'response.usage.priced': Deferred<readonly PricedCall[]>;
}

export const priceCalls = (calls: readonly BillableCall[]): readonly PricedCall[] => calls.map(call => {
  const measurement = call.measurement ?? tokenUsageMeasurement(tokenUsageFromBillableUsage(call.usage ?? undefined));
  const pricing = priceUsageMeasurement(call.identity.pricing, measurement.quantities, call.pricingFacts);
  return { ...call, ...pricing, dumpTokenUsage: measurement.dumpTokenUsage };
});

type Billings = Pick<UsageFacts, 'response.usage.billable'>;
export const priceUsage = defineStage<object, object, Billings, Billings & PricedUsageFacts>({
  name: 'priceUsage',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.usage.billable'], consumes: [], provides: ['response.usage.priced'] },
  },
  execute: async (request, next, env) => {
    const response = await next(request);
    return {
      ...response,
      'response.usage.priced': env.defer('priced usage', response['response.usage.billable'].promise.then(priceCalls)),
    };
  },
});

export interface Settlement {
  readonly persisted: boolean;
  readonly errors: readonly ErrorSnapshot[];
  readonly usageWrites: readonly { readonly callId: string; readonly receipt: UsageWriteReceipt }[];
  readonly status: number;
  readonly outcome: 'success' | 'gateway-error' | 'upstream-error' | 'failed';
  readonly identity: TelemetryModelIdentity | null;
  readonly tokenUsage: TokenUsage | null;
  readonly firstOutputAt: number | null;
  readonly streamEndedAt: number | null;
  readonly upstreamStartedAt: number | null;
  readonly upstreamId: string | null;
  readonly targetApi: ChatTargetApi | null;
}

export interface SettlementFacts { readonly 'response.settlement': Deferred<Settlement> }

type SettlementServices = Pick<GatewayServices, 'usageStore' | 'performanceStore'>;
type SettlementInput = Pick<GatewayRouteFacts, 'request.auth.apiKeyId' | 'request.route.runtimeLocation'>;
type SettlementResponse = HttpOutput & UsageFacts & PricedUsageFacts & HttpDeliveryFacts & RenderFacts & AnswerFacts
  & Partial<Pick<SelectedAttemptResponse, 'response.route.candidate' | 'response.usage.selected'>> & {
    readonly 'response.targetApi'?: ChatTargetApi;
  };

const consumedUsageKeys = ['response.usage.billable', 'response.usage.priced'] as const;
type SettledResponse = Omit<SettlementResponse, typeof consumedUsageKeys[number]> & SettlementFacts;

export const persistBillableCalls = async (
  calls: readonly PricedCall[], keyId: string, usageStore: GatewayServices['usageStore'], log?: Pick<StageLogger, 'error'>,
): Promise<Settlement['usageWrites']> => {
  const hour = currentHour();
  const unique = [...new Map(calls.map(call => [call.callId, call])).values()];
  return await Promise.all(unique.map(async call => {
    const receipt = await usageStore.record(call.callId, {
      keyId, hour, model: call.identity.model, upstream: call.identity.upstream, modelKey: call.identity.modelKey,
      requests: 1, pricingSelector: call.pricingSelector, metrics: call.metrics,
    });
    if (receipt.usage !== 'written') log?.error('Failed to record usage:', { callId: call.callId, error: { ...receipt.usage.error } });
    if (receipt.lastUsedAt !== 'written') log?.error('Failed to update API key lastUsedAt:', { callId: call.callId, error: { ...receipt.lastUsedAt.error } });
    return { callId: call.callId, receipt };
  }));
};

export type SearchUsageSettlement = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

export const persistSearchUsage = async (
  row: WebSearchUsageRecord, store: GatewayServices['searchUsageStore'], log?: Pick<StageLogger, 'error'>,
): Promise<SearchUsageSettlement> => {
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

const persist = async (
  request: SettlementInput, response: SettlementResponse, operation: PerformanceOperation | null, services: SettlementServices, log: StageLogger,
  usageWrite: Deferred<Settlement['usageWrites']>,
): Promise<Settlement> => {
  const [calls, firstOutputAt, streamEndedAt, delivery, render, selected] = await Promise.all([
    response['response.usage.priced'].promise,
    response['response.timing.firstOutputAt'].promise,
    response['response.timing.streamEndedAt'].promise,
    response['response.delivery'].promise,
    response['response.render'].promise,
    response['response.usage.selected']?.promise.catch(() => undefined),
  ]);
  const http = response['response.http'];
  const candidate = response['response.route.candidate'];
  const selectedIds = new Set(selected?.map(call => call.callId));
  const selectedCalls = calls.filter(call => selectedIds.has(call.callId));
  const last = selectedCalls.at(-1);
  const outcome = render.kind !== 'completed' || delivery.kind === 'write-failed'
    ? 'failed'
    : http.status < 200 || http.status >= 300 ? response['response.source'] === 'gateway' ? 'gateway-error' : 'upstream-error' : 'success';
  const keyId = request['request.auth.apiKeyId'];
  const performanceOperation = response['response.performance.operation'] ?? operation;
  const writePerformance = async (): Promise<ErrorSnapshot | undefined> => {
    if (candidate === undefined || performanceOperation === null) return;
    const outputTokens = render.kind === 'failed' && render.reason === 'collect-error'
      ? 0
      : selectedCalls.reduce((sum, call) => sum + (call.dumpTokenUsage?.output ?? 0), 0);
    const record = performanceRecord({
      dimensions: { keyId, hour: currentHour(), model: candidate.modelId, upstream: candidate.upstreamId, operation: performanceOperation, runtimeLocation: request['request.route.runtimeLocation'] },
      firstOutputAt,
      streamEndedAt,
      upstreamStartedAt: http.timing.startedAt,
      outputTokens,
      failed: outcome !== 'success',
    });
    try {
      await services.performanceStore.record(record);
    } catch (cause) {
      const error = snapshotError(cause);
      console.warn(`Failed to record performance ${record.kind}:`, cause);
      log.warn(`Failed to record performance ${record.kind}:`, { error: { ...error } });
      return error;
    }
  };
  const [usageWrites, performanceError] = await Promise.all([
    usageWrite.promise,
    writePerformance(),
  ]);
  const usageErrors = usageWrites.flatMap(({ receipt }) => [receipt.usage, receipt.lastUsedAt].flatMap(result => result === 'written' ? [] : [result.error]));
  const errors = performanceError === undefined ? usageErrors : [...usageErrors, performanceError];

  return {
    persisted: errors.length === 0,
    errors,
    usageWrites,
    status: http.status,
    outcome,
    identity: last?.identity ?? null,
    tokenUsage: last?.dumpTokenUsage ?? null,
    firstOutputAt,
    streamEndedAt,
    upstreamStartedAt: candidate === undefined ? null : http.timing.startedAt,
    upstreamId: candidate?.upstreamId ?? null,
    targetApi: response['response.targetApi'] ?? null,
  };
};

export const writeSettlement = (operation: PerformanceOperation | null) =>
  defineStage<SettlementInput, SettlementInput, SettlementResponse, SettledResponse, SettlementServices>({
    name: 'writeSettlement',
    through: {
      request: { needs: ['request.auth.apiKeyId', 'request.route.runtimeLocation'], consumes: [], provides: [] },
      response: {
        needs: ['response.http', 'response.source', 'response.delivery', 'response.render', ...consumedUsageKeys, 'response.timing.firstOutputAt', 'response.timing.streamEndedAt'],
        consumes: consumedUsageKeys,
        provides: ['response.settlement'],
      },
    },
    execute: async (request, next, env) => {
      const response = await next(request);
      const { 'response.usage.billable': _billable, 'response.usage.priced': priced, ...settled } = response;
      const writes = env.defer('usage writes', priced.promise.then(calls => persistBillableCalls(calls, request['request.auth.apiKeyId'], env.services.usageStore, env.log)));
      return {
        ...settled,
        'response.settlement': env.defer('settlement', persist(request, response, operation, env.services, env.log, writes)),
      };
    },
  });
