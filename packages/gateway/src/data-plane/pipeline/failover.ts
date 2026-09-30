import type { GatewayServices } from './services.ts';
import type { Slice } from './stage-contracts.ts';
import { defineStage, move, type Facts } from '@floway-dev/pipeline';

/**
 * Runs what follows it once per candidate and returns the first that did not fail.
 *
 * The losing attempts' bodies are its own — that is what `consumes` declares on the way up
 * — and the winner's rides onward, which is what `provides` declares. Failover never
 * breaks a stream: once one has opened there is nothing to fail over to, and the family's
 * edge is what settles that by sitting above this stage rather than below it.
 */
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
}

export const failover = ({ failed, owns }: Forking) => defineStage<
  Slice<'serve.candidates'>,
  Slice<'serve.candidates' | 'route.attempt'>,
  Slice<'response.usage.billable'>,
  Slice<'response.usage.billable'>,
  GatewayServices
>({
  name: 'failover',
  through: {
    request: { needs: ['serve.candidates'], consumes: [], provides: ['route.attempt'] },
    response: {
      needs: ['response.usage.billable'],
      // Owned on the way up and handed onward: every attempt's is this stage's to release,
      // and the one it adopts rides up with ownership going with it.
      consumes: owns as never,
      provides: owns as never,
    },
  },
  execute: async (facts, next, use) => {
    let last: Slice<'response.usage.billable'> | undefined;
    for (const candidate of facts['serve.candidates']) {
      // Per-attempt telemetry state, cleared before control leaves, so a mid-attempt throw
      // still attributes its performance row to the candidate that was being tried.
      use.gateway.attempt.timing.upstreamCallStartedAt = null;
      use.gateway.attempt.timing.firstOutputTokenAt = null;
      last = await next({ ...facts, 'route.attempt': move(candidate) });
      if (!failed(last as Facts)) return last;
      use.log.info('candidate failed, trying the next', { upstream: candidate.upstreamId });
    }
    if (last === undefined) throw new Error('failover: assembly handed it an empty candidate list');
    // Every candidate failed, and the last failure is the base — so the client sees real
    // upstream telemetry rather than a synthesized gateway envelope.
    return last;
  },
});
