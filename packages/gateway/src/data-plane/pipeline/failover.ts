import type { BillableEntity } from './facts.ts';
import type { StreamOutcome } from './serve.ts';
import type { GatewayServices } from './services.ts';
import type { Slice } from './stage-contracts.ts';
import { defer, defineStage, move, type Facts, type Deferred } from '@floway-dev/pipeline';

export interface Forking {
  /** How this family reads an attempt's outcome. Branching is the framework's; what
   *  something branches on is the domain's. */
  readonly failed: (handedUp: Facts) => boolean;
  /** The keys at which this family's attempts hand up something the run owns — an upstream
   *  body still open, most often. A family whose ending reads its answer to the end owns
   *  nothing and names nothing here, and one that streams names the key it streams at.
   *
   *  It cannot be a fixed key. Declaring `provides` for a key a family never produces makes
   *  the runner throw on the first real request, and declaring `consumes` for one it does
   *  produce and hands up makes it throw the other way. Which keys carry a resource is a
   *  statement only the family can make. */
  readonly owns: readonly string[];
  readonly streamedUsage?: string;
}

export const failover = ({ failed, owns, streamedUsage }: Forking) => defineStage<
  Slice<'serve.candidates'>,
  Slice<'serve.candidates' | 'route.attempt'>,
  Slice<'response.usage.billable'> & Record<string, unknown>,
  Slice<'response.usage.billable'> & Record<string, unknown>,
  GatewayServices
>({
  name: 'failover',
  through: {
    request: { needs: ['serve.candidates'], consumes: [], provides: ['route.attempt'] },
    response: {
      needs: ['response.usage.billable', ...(streamedUsage === undefined ? [] : [streamedUsage])],
      // Owned on the way up and handed onward: every attempt's is this stage's to release,
      // and the one it adopts rides up with ownership going with it.
      consumes: owns as never,
      provides: [...owns, ...(streamedUsage === undefined ? [] : ['response.usage.billable', streamedUsage])] as never,
    },
  },
  execute: async (facts, next, use) => {
    let last: Slice<'response.usage.billable'> | undefined;
    const prior: BillableEntity[] = [];
    const keepPriorCalls = (back: Slice<'response.usage.billable'>): Slice<'response.usage.billable'> => {
      if (prior.length === 0) return back;
      const record = back as unknown as Facts;
      const pending = streamedUsage === undefined ? null : record[streamedUsage] as Deferred<StreamOutcome> | null;
      const calls = move([...prior]);
      return move({
        ...back,
        'response.usage.billable': move([...calls, ...back['response.usage.billable']]),
        ...(streamedUsage === undefined || pending === null ? {} : {
          [streamedUsage]: move(defer(pending.then(outcome => ({ ...outcome, billable: move([...calls, ...outcome.billable]) })))),
        }),
      });
    };
    for (const [index, candidate] of facts['serve.candidates'].entries()) {
      // Per-attempt telemetry state, cleared before control leaves, so a mid-attempt throw
      // still attributes its performance row to the candidate that was being tried.
      use.gateway.attempt.timing.upstreamCallStartedAt = null;
      use.gateway.attempt.timing.firstOutputTokenAt = null;
      last = await next({ ...facts, 'route.attempt': move(candidate) });
      if (!failed(last as Facts) || index === facts['serve.candidates'].length - 1) return keepPriorCalls(last);
      if (streamedUsage !== undefined) prior.push(...last['response.usage.billable']);
      use.log.info('candidate failed, trying the next', { upstream: candidate.upstreamId });
    }
    if (last === undefined) throw new Error('failover: assembly handed it an empty candidate list');
    // Every candidate failed, and the last failure is the base — so the client sees real
    // upstream telemetry rather than a synthesized gateway envelope.
    return last;
  },
});
