import type { BillableEntity, GatewayFacts, AttemptSelector } from './facts.ts';
import { providerCalls } from './provider-usage.ts';
import type { StreamOutcome } from './serve.ts';
import type { GatewayServices } from './services.ts';
import type { TokenUsage, UsageQuantities } from '../../repo/types.ts';
import { recordPerformance } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { defineStage, getFailureFacts, move, type Logger, type Deferred, type Facts } from '@floway-dev/pipeline';
import type { BillingMetric } from '@floway-dev/protocols/common';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

const dumpUsage = (quantities: UsageQuantities): TokenUsage => {
  const count = (metric: BillingMetric): number | undefined =>
    quantities[metric] === undefined ? undefined : Number(quantities[metric]);
  return {
    ...(count('input_tokens') === undefined ? {} : { input: count('input_tokens') }),
    ...(count('input_cache_read_tokens') === undefined ? {} : { input_cache_read: count('input_cache_read_tokens') }),
    ...(count('input_cache_write_tokens') === undefined ? {} : { input_cache_write: count('input_cache_write_tokens') }),
    ...(count('input_cache_write_1h_tokens') === undefined ? {} : { input_cache_write_1h: count('input_cache_write_1h_tokens') }),
    ...(count('input_image_tokens') === undefined ? {} : { input_image: count('input_image_tokens') }),
    ...(count('output_tokens') === undefined ? {} : { output: count('output_tokens') }),
    ...(count('output_image_tokens') === undefined ? {} : { output_image: count('output_image_tokens') }),
  };
};

/** Usage writes are bound to the request lifetime without delaying an upstream response. */
export const settleBillable = (
  services: Pick<GatewayServices, 'gateway' | 'background'> & { readonly log: Logger },
  billable: readonly BillableEntity[],
  failed: boolean,
  finishedAt: number = performance.now(),
): void => {
  for (const entity of billable) {
    services.gateway.dump?.success(entity.identity, dumpUsage(entity.quantities));
    services.background(recordUsage(
      services.gateway.apiKeyId,
      entity.identity,
      entity.quantities,
      entity.pricingFacts ?? {},
    ));
  }
  if (failed) services.gateway.dump?.failed('The upstream response failed.', { fallback: true });
  const outputTokens = billable.reduce((total, entity) => total + Number(entity.quantities.output_tokens ?? 0), 0);
  recordPerformance(services.gateway, services.gateway.attempt.telemetry, failed, outputTokens, finishedAt);
};

/** Settles a run once at its exit, including calls completed before a later stage throws. */
export const writeSettlement = (
  failed: (handedUp: Record<string, unknown>) => boolean,
  pendingUsage?: string,
) => defineStage<
  Record<string, never>,
  Slice<'serve.usage.prior'>,
  Slice<'response.usage.billable' | 'serve.usage.prior'>,
  Slice<'response.usage.billable'>,
  GatewayServices
>({
  name: 'writeSettlement',
  through: {
    request: { needs: [], consumes: [], provides: ['serve.usage.prior'] },
    response: { needs: ['response.usage.billable'], consumes: ['serve.usage.prior'], provides: [] },
  },
  execute: async (facts, next, use) => {
    const entry = { ...facts, 'serve.usage.prior': move([]) };
    let back: Slice<'response.usage.billable' | 'serve.usage.prior'>;
    try {
      back = await next(entry);
    } catch (error) {
      const atFailure = getFailureFacts(error) ?? entry;
      settleExit(use, atFailure, true, pendingUsage);
      throw error;
    }
    settleExit(use, back, failed(back as Facts), pendingUsage);
    const { 'serve.usage.prior': _prior, ...rest } = back as Slice<'response.usage.billable' | 'serve.usage.prior'>;
    return rest;
  },
});

const settleExit = (
  use: GatewayServices & { readonly log: Logger },
  facts: Facts,
  failed: boolean,
  pendingUsage: string | undefined,
): void => {
  const pending = pendingUsage === undefined || !(pendingUsage in facts)
    ? null : facts[pendingUsage] as Deferred<StreamOutcome> | null;
  if (pending !== null) {
    use.background(pending.then(outcome => {
      settleBillable(use, outcome.billable, failed || outcome.failed);
    }));
    return;
  }
  if ('response.usage.billable' in facts) {
    settleBillable(use, facts['response.usage.billable'] as readonly BillableEntity[], failed);
    return;
  }
  const prior = facts['serve.usage.prior'] as readonly BillableEntity[];
  if (!('response.provider.called' in facts)) {
    settleBillable(use, prior, failed);
    return;
  }
  const candidate = use.resolveAttempt(facts['route.attempt'] as AttemptSelector);
  settleBillable(use, [...prior, ...providerCalls(candidate, facts)], failed);
};
