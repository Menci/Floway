import type { HttpDeliveryFacts, HttpOutput } from './edge-http.ts';
import type { SelectedAttemptResponse } from './failover.ts';
import type { BillableCall, UsageFacts } from './observe-usage.ts';
import type { RenderFacts } from './render.ts';
import type { GatewayRouteFacts, GatewayServices } from './services.ts';
import type { TokenUsage, UsageRecord } from '../../repo/types.ts';
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

const priceCalls = (calls: readonly BillableCall[]): readonly PricedCall[] => calls.map(call => {
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
type SettlementResponse = HttpOutput & UsageFacts & PricedUsageFacts & HttpDeliveryFacts & RenderFacts
  & Partial<Pick<SelectedAttemptResponse, 'response.route.candidate' | 'response.usage.selected'>> & {
    readonly 'response.targetApi'?: ChatTargetApi;
  };

const persist = async (
  request: SettlementInput, response: SettlementResponse, operation: PerformanceOperation | null, services: SettlementServices, log: StageLogger,
): Promise<Settlement> => {
  const [calls, firstOutputAt, streamEndedAt, delivery, render, selected] = await Promise.all([
    response['response.usage.priced'].promise,
    response['response.timing.firstOutputAt'].promise,
    response['response.timing.streamEndedAt'].promise,
    response['response.delivery'].promise,
    response['response.render'].promise,
    response['response.usage.selected']?.promise,
  ]);
  const http = response['response.http'];
  const candidate = response['response.route.candidate'];
  const selectedIds = new Set(selected?.map(call => call.callId));
  const selectedCalls = calls.filter(call => selectedIds.has(call.callId));
  const last = selectedCalls.at(-1);
  const outcome = render.kind === 'failed' || delivery.kind !== 'completed'
    ? 'failed'
    : http.status < 200 || http.status >= 300 ? candidate === undefined ? 'gateway-error' : 'upstream-error' : 'success';
  const hour = currentHour();
  const keyId = request['request.auth.apiKeyId'];
  const writes = calls.map(call => ({
    label: 'usage',
    write: services.usageStore.record({
      keyId, hour, model: call.identity.model, upstream: call.identity.upstream, modelKey: call.identity.modelKey,
      requests: 1, pricingSelector: call.pricingSelector, metrics: call.metrics,
    }),
  }));

  if (candidate !== undefined && operation !== null) {
    const outputTokens = render.kind === 'failed' && render.reason === 'collect-error'
      ? 0
      : selectedCalls.reduce((sum, call) => sum + (call.dumpTokenUsage?.output ?? 0), 0);
    const record = performanceRecord({
      dimensions: { keyId, hour, model: candidate.modelId, upstream: candidate.upstreamId, operation, runtimeLocation: request['request.route.runtimeLocation'] },
      firstOutputAt,
      streamEndedAt,
      upstreamStartedAt: http.timing.startedAt,
      outputTokens,
      failed: outcome !== 'success',
    });
    writes.push({ label: `performance ${record.kind}`, write: services.performanceStore.record(record) });
  }

  const results = await Promise.allSettled(writes.map(item => item.write));
  const errors = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const error = snapshotError(result.reason);
    const { label } = writes[index]!;
    const fields = { error: { ...error } };
    if (label === 'usage') {
      console.error('Failed to record usage:', result.reason);
      log.error('Failed to record usage:', fields);
    } else {
      console.warn(`Failed to record ${label}:`, result.reason);
      log.warn(`Failed to record ${label}:`, fields);
    }
    return [error];
  });

  return {
    persisted: errors.length === 0,
    errors,
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
  defineStage<SettlementInput, SettlementInput, SettlementResponse, SettlementResponse & SettlementFacts, SettlementServices>({
    name: 'writeSettlement',
    through: {
      request: { needs: ['request.auth.apiKeyId', 'request.route.runtimeLocation'], consumes: [], provides: [] },
      response: {
        needs: ['response.http', 'response.delivery', 'response.render', 'response.usage.priced', 'response.timing.firstOutputAt', 'response.timing.streamEndedAt'],
        consumes: [],
        provides: ['response.settlement'],
      },
    },
    execute: async (request, next, env) => {
      const response = await next(request);
      return {
        ...response,
        'response.settlement': env.defer('settlement', persist(request, response, operation, env.services, env.log)),
      };
    },
  });
