// Settlement, as a stage. It sits **above** the fork, so a run bills once however many
// candidates it tried — repetition passes through the stage that observes usage, and not
// through this one.
//
// It is unconditional: a run that measured rather than generated still writes, and its row
// simply names no billed entity. Emptiness is observed, not declared — which is why there
// is no "unknown" anywhere here. The situations are concrete and the list is open: the
// upstream reported zero, we did not call an upstream, we failed before reaching the
// upstream's usage, the upstream did not report.

import type { BillableEntity, GatewayFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import type { TokenUsage, UsageQuantities } from '../../repo/types.ts';
import { recordPerformance } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { Logger } from '@floway-dev/pipeline';
import type { BillingMetric } from '@floway-dev/protocols/common';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

/** The dump's own two columns, read back out of what was billed.
 *
 *  The dump sums every input category into one number and keeps output separate, and it
 *  distinguishes "not measured" from "measured zero" — so an entity that reported nothing
 *  contributes no keys and stays null rather than becoming a zero the upstream never said. */
const dumpUsage = (quantities: UsageQuantities): TokenUsage => {
  const count = (metric: BillingMetric): number | undefined =>
    quantities[metric] === undefined ? undefined : Number(quantities[metric]);
  return {
    ...(count('input_tokens') === undefined ? {} : { input: count('input_tokens') }),
    ...(count('input_cache_read_tokens') === undefined ? {} : { input_cache_read: count('input_cache_read_tokens') }),
    ...(count('input_cache_write_tokens') === undefined ? {} : { input_cache_write: count('input_cache_write_tokens') }),
    ...(count('input_image_tokens') === undefined ? {} : { input_image: count('input_image_tokens') }),
    ...(count('output_tokens') === undefined ? {} : { output: count('output_tokens') }),
    ...(count('output_image_tokens') === undefined ? {} : { output_image: count('output_image_tokens') }),
  };
};

/**
 * Writes what was billed, and the performance sample that goes with it.
 *
 * The usage write is scheduled rather than awaited. A transient repository failure must not
 * turn an upstream's already-flowing response into a 502, and the run's own answer does not
 * depend on the row — so it is handed to the background scheduler, which binds it to the
 * request's lifetime on both deployment targets.
 *
 * A streaming family settles through this too, from the prologue after the drain: its
 * numbers arrive with the stream's last chunk, which is after the run has answered.
 */
export const settleBillable = (
  services: Pick<GatewayServices, 'gateway' | 'background'> & { readonly log: Logger },
  billable: readonly BillableEntity[],
  failed: boolean,
  outputTokens = 0,
  finishedAt: number = performance.now(),
): void => {
  for (const entity of billable) {
    // The dump names the upstream that answered and what it metered, which is the same
    // reading the row is written from rather than a second one taken separately.
    if (!failed) services.gateway.dump?.success(entity.identity, dumpUsage(entity.quantities));
    services.background(recordUsage(
      services.gateway.apiKeyId,
      entity.identity,
      entity.quantities,
      entity.pricingFacts ?? {},
    ).catch((error: unknown) => {
      services.log.error('failed to record usage', { error: String(error) });
    }));
  }
  recordPerformance(services.gateway, services.gateway.attempt.telemetry, failed, outputTokens, finishedAt);
};

/**
 * Prices what was observed and writes it, once per run.
 *
 * `stillReading` is how a streaming family says its numbers have not arrived yet: they come
 * with the stream's last chunk, which is after this stage has handed up. Settling here as
 * well would write the row twice — once for the entity that had reported nothing and once
 * for what the stream turned out to say — so the run settles wherever the numbers are, and
 * for a stream that is the epilogue.
 */
export const writeSettlement = (
  failed: (handedUp: Record<string, unknown>) => boolean,
  stillReading?: (handedUp: Record<string, unknown>) => boolean,
) => defineStage<
  Slice<'serve.model'>,
  Slice<'serve.model'>,
  Slice<'response.usage.billable'>,
  Slice<'response.usage.billable'>,
  GatewayServices
>({
  name: 'writeSettlement',
  through: {
    request: { needs: ['serve.model'], consumes: [], provides: [] },
    // It reads the authoritative reading and hands it on untouched: settlement is the last
    // reader, not another writer, and a stage that changed usage re-provided it below.
    response: { needs: ['response.usage.billable'], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    if (stillReading?.(back as Record<string, unknown>) === true) return back;
    // One performance sample per run, attributed to the attempt that answered.
    settleBillable(use, back['response.usage.billable'], failed(back as Record<string, unknown>));
    return back;
  },
});
