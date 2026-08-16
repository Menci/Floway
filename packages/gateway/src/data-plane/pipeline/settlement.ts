// Settlement, as a stage. It sits **above** the fork, so a run bills once however many
// candidates it tried — repetition passes through the stage that observes usage, and not
// through this one.
//
// It is unconditional: a run that measured rather than generated still writes, and its row
// simply names no billed entity. Emptiness is observed, not declared — which is why there
// is no "unknown" anywhere here. The situations are concrete and the list is open: the
// upstream reported zero, we did not call an upstream, we failed before reaching the
// upstream's usage, the upstream did not report.

import type { GatewayFacts } from './facts.ts';
import type { GatewayServices } from './services.ts';
import { recordPerformance } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { defineStage } from '@floway-dev/pipeline';

type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };

/**
 * Prices what was observed and writes it, once per run.
 *
 * The write is scheduled rather than awaited. A transient repository failure must not turn
 * an upstream's already-flowing response into a 502, and the run's own answer does not
 * depend on the row — so it is handed to the background scheduler, which binds it to the
 * request's lifetime on both deployment targets.
 */
export const writeSettlement = (failed: (handedUp: Record<string, unknown>) => boolean) => defineStage<
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
    for (const entity of back['response.usage.billable']) {
      use.background(recordUsage(
        use.gateway.apiKeyId,
        entity.identity,
        entity.quantities,
        entity.pricingFacts ?? {},
      ).catch((error: unknown) => {
        use.log.error('failed to record usage', { error: String(error) });
      }));
    }
    // One performance sample per run, attributed to the attempt that answered.
    recordPerformance(use.gateway, use.gateway.attempt.telemetry, failed(back as Record<string, unknown>), 0, performance.now());
    return back;
  },
});
