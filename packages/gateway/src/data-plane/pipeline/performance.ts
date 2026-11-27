import type { MeteredEvent, MeteredOutcome, MeteredStreamReader, UsageObservation } from './compute-usage.ts';
import type { GatewayServices } from './services.ts';
import { attemptTtftMs } from '../shared/attempt-timing.ts';
import type { Deferred, ManagedStream, Result } from '@floway-dev/pipeline';
import type { PerformanceOperation, ProtocolStreamError } from '@floway-dev/upstream';

type Usage = Deferred<UsageObservation>;
type Stream<Event> = ManagedStream<Event, ProtocolStreamError>;
type Items<Event> = AsyncGenerator<Result<Event, ProtocolStreamError>, void, unknown>;

export interface PerformanceMeasurement {
  operation: PerformanceOperation;
  upstream: string;
  model: string;
  failed: boolean;
  ttftMs: number | null;
  tpotUs?: number;
}

interface PerformanceWorker {
  detach(worker: (scope: { services: Pick<GatewayServices, 'recordPerformance'> }) => Promise<unknown>): void;
}

interface PerformanceScope extends PerformanceWorker {
  wrapDeferred(source: Usage, factory: (source: Usage, producer: { read(source: Usage): Promise<UsageObservation> }) => Promise<UsageObservation>): Usage;
  wrapStream<Event>(source: Stream<Event>, factory: (source: Stream<Event>, producer: MeteredStreamReader & PerformanceWorker) => Items<Event>): Stream<Event>;
}

interface PerformanceOptions<Event> {
  operation: PerformanceOperation;
  upstream: string;
  model: string;
  startedAt?: number | undefined;
  isFirstOutput?(event: Event): boolean;
}

export const observePerformance = <Outcome extends MeteredOutcome>(
  scope: PerformanceScope,
  outcome: Outcome,
  sourceUsage: Usage,
  { operation, upstream, model, startedAt, isFirstOutput }: PerformanceOptions<MeteredEvent<Outcome>>,
): { outcome: Outcome; usage: Usage } => {
  if (outcome.kind === 'error' && outcome.source === 'local') return { outcome, usage: sourceUsage };

  // The factory opens usage synchronously, so the client path and the
  // performance sample can depend on the same measurement.
  let observed!: Promise<UsageObservation>;
  const usage = scope.wrapDeferred(sourceUsage, (inner, producer) => {
    observed = producer.read(inner);
    return observed;
  });
  const timing = { upstreamCallStartedAt: startedAt ?? null, firstOutputTokenAt: null as number | null };
  const finish = (producer: PerformanceWorker, failed: boolean): void => {
    const finishedAt = performance.now();
    producer.detach(async ({ services }) => {
      const observation = await observed;
      const outputTokens = observation.kind === 'observed'
        ? observation.usage.reduce((sum, entry) => sum + Number(entry.quantities.output_tokens ?? '0'), 0)
        : 0;
      if (outputTokens < 0) throw new RangeError(`Negative output token count: ${outputTokens}`);
      const ttftMs = (failed && outputTokens === 0) || operation !== 'chat' ? null : attemptTtftMs(timing);
      const tpotUs = ttftMs !== null && timing.firstOutputTokenAt !== null && outputTokens >= 2
        ? Math.round((finishedAt - timing.firstOutputTokenAt) * 1_000 / (outputTokens - 1))
        : undefined;
      await services.recordPerformance({
        operation, upstream, model, failed, ttftMs, ...(tpotUs === undefined ? {} : { tpotUs }),
      });
    });
  };
  if (outcome.kind !== 'stream') {
    finish(scope, outcome.kind === 'error');
    return { outcome, usage };
  }

  const firstOutput = (event: MeteredEvent<Outcome>): void => {
    if (timing.firstOutputTokenAt === null && isFirstOutput?.(event)) timing.firstOutputTokenAt = performance.now();
  };
  const stream = scope.wrapStream(outcome.stream as Stream<MeteredEvent<Outcome>>, async function* (source, producer) {
    for await (const item of producer.read(source)) {
      if (!item.ok) {
        if (item.error.kind !== 'abort') finish(producer, true);
        producer.discard(source);
        yield item;
        return;
      }
      firstOutput(item.value);
      yield item;
    }
    finish(producer, false);
  });
  return { outcome: { ...outcome, stream }, usage };
};
