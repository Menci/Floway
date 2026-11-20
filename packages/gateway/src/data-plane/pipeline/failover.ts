import { isFailure, type BillableEntity } from './facts.ts';
import type { StreamOutcome } from './serve.ts';
import type { GatewayServices } from './services.ts';
import type { Slice } from './stage-contracts.ts';
import { retryTime } from '../shared/retry-after.ts';
import { defineStage, move, defer, type Deferred, type Facts } from '@floway-dev/pipeline';

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
  readonly answer: (handedUp: Facts) => unknown;
  /** The keys at which this family's attempts hand up something the run owns — an upstream
   *  body still open, most often. A family whose ending reads its answer to the end owns
   *  nothing and names nothing here, and one that streams names the key it streams at.
   *
   *  It cannot be a fixed key. Declaring `provides` for a key a family never produces makes
   *  the runner throw on the first real request, and declaring `consumes` for one it does
   *  produce and hands up makes it throw the other way. Which keys carry a resource is a
   *  statement only the family can make. */
  readonly owns: readonly string[];
  readonly pendingUsage?: string;
}

type AttemptResponse = Slice<'response.usage.billable' | 'response.http.headers'>;

export const failover = ({ answer, owns, pendingUsage }: Forking) => defineStage<
  Slice<'serve.candidates' | 'serve.usage.prior'>,
  Slice<'serve.candidates' | 'route.attempt' | 'serve.usage.prior'>,
  AttemptResponse,
  Slice<'response.usage.billable' | 'serve.usage.prior'>,
  GatewayServices
>({
  name: 'failover',
  through: {
    request: { needs: ['serve.candidates', 'serve.usage.prior'], consumes: [], provides: ['route.attempt', 'serve.usage.prior'] },
    response: {
      needs: ['response.usage.billable', 'response.http.headers', ...(pendingUsage === undefined ? [] : [pendingUsage])] as never,
      // Owned on the way up and handed onward: every attempt's is this stage's to release,
      // and the one it adopts rides up with ownership going with it.
      consumes: owns as never,
      provides: [...owns, 'response.usage.billable', 'serve.usage.prior', ...(pendingUsage === undefined ? [] : [pendingUsage])] as never,
    },
  },
  execute: async (facts, next, use) => {
    let selected: AttemptResponse | undefined;
    let earliestRetryTime: number | null = null;
    let lastTransportError: Error | undefined;
    let observed: readonly BillableEntity[] = [];
    for (const candidate of facts['serve.candidates']) {
      use.gateway.abortSignal?.throwIfAborted();
      // Per-attempt telemetry state, cleared before control leaves, so a mid-attempt throw
      // still attributes its performance row to the candidate that was being tried.
      use.gateway.attempt.timing.upstreamCallStartedAt = null;
      use.gateway.attempt.timing.firstOutputTokenAt = null;
      const result = await next({ ...facts, 'route.attempt': move(candidate), 'serve.usage.prior': move([...facts['serve.usage.prior'], ...observed]) });
      const prior = observed;
      observed = [...observed, ...result['response.usage.billable']];
      const attempt = answer(result);
      if (!isFailure(attempt)) {
        if (prior.length === 0) return { ...result, 'serve.usage.prior': facts['serve.usage.prior'] };
        const pending = pendingUsage === undefined ? null : (result as Facts)[pendingUsage] as Deferred<StreamOutcome> | null;
        return {
          ...result,
          'serve.usage.prior': facts['serve.usage.prior'],
          'response.usage.billable': move(observed),
          ...(pending === null ? {} : {
            [pendingUsage!]: move(defer(pending.then(outcome => ({ ...outcome, billable: [...prior, ...outcome.billable] })))),
          }),
        };
      }
      lastTransportError = attempt.transportError;
      if (lastTransportError === undefined) {
        const headers = result['response.http.headers'].map(([name, value]): [string, string] => [name, value]);
        const time = retryTime(new Headers(headers).get('retry-after'));
        if (earliestRetryTime === null || (time !== null && time < earliestRetryTime)) {
          selected = result;
          earliestRetryTime = time;
        }
      }
      await use.log.info('candidate failed, trying the next', { upstream: candidate.upstreamId });
    }
    if (earliestRetryTime === null && lastTransportError !== undefined) throw lastTransportError;
    if (selected === undefined) throw new Error('failover: assembly handed it an empty candidate list');
    return { ...selected, 'serve.usage.prior': facts['serve.usage.prior'], 'response.usage.billable': move(observed) };
  },
});
