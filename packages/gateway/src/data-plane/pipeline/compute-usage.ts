import type { UsageMeasurement } from '../shared/telemetry/usage.ts';
import type { Deferred, ManagedStream, Result } from '@floway-dev/pipeline';
import type { ProtocolError, ProtocolResult, ProtocolStream, ProtocolStreamError } from '@floway-dev/upstream';

type Usage = readonly UsageMeasurement[];

export type MeasuredUsage = Pick<UsageMeasurement, 'quantities' | 'pricingFacts'> & {
  readonly reported: boolean;
};

export type UsageObservation =
  | { kind: 'observed'; usage: readonly [] }
  | { kind: 'observed'; usage: readonly MeasuredUsage[]; modelKey: string }
  | { kind: 'upstream-error' }
  | { kind: 'local' };

export interface StreamUsage<Event> {
  frame(event: Event): Usage | undefined;
  done(): Usage;
  error?(error: ProtocolStreamError): Usage | undefined;
}

export type MeteredOutcome = ProtocolError | ProtocolResult<unknown> | ProtocolStream<unknown>;
export type MeteredEvent<Outcome> = Outcome extends ProtocolStream<infer Event> ? Event : never;
type MeteredResult<Outcome> = Outcome extends ProtocolResult<infer Output> ? Output : never;

type Stream<Event> = ManagedStream<Event, ProtocolStreamError>;
type Items<Event> = AsyncGenerator<Result<Event, ProtocolStreamError>, void, unknown>;

export interface MeteredStreamReader {
  read<Event>(source: Stream<Event>): AsyncIterableIterator<Result<Event, ProtocolStreamError>>;
  discard(source: Stream<unknown>): void;
}

interface UsageScope {
  createDeferred(factory: () => Promise<UsageObservation>): Deferred<UsageObservation>;
  wrapStream<Event>(source: Stream<Event>, factory: (source: Stream<Event>, producer: MeteredStreamReader) => Items<Event>): Stream<Event>;
}

interface UsageReaders<Outcome> {
  result?(result: MeteredResult<Outcome>): Usage;
  stream?(): StreamUsage<MeteredEvent<Outcome>>;
}

export const observeUsage = <Outcome extends MeteredOutcome>(
  scope: UsageScope,
  outcome: Outcome,
  modelKey: string,
  readers: UsageReaders<Outcome>,
): { outcome: Outcome; usage: Deferred<UsageObservation> } => {
  const observe = (usage: Usage): UsageObservation => {
    if (usage.length === 0) return { kind: 'observed', usage: [] };
    if (modelKey === '') throw new Error('The upstream returned billable usage without a dispatched model key');
    return {
      kind: 'observed',
      usage: usage.map(({ quantities, pricingFacts, dumpTokenUsage }) => ({
        quantities,
        pricingFacts,
        reported: dumpTokenUsage !== null || Object.keys(quantities).length > 0,
      })),
      modelKey,
    };
  };
  if (outcome.kind === 'error') {
    return {
      outcome,
      usage: scope.createDeferred(async () => ({ kind: outcome.source === 'upstream' ? 'upstream-error' : 'local' })),
    };
  }
  if (outcome.kind === 'result') {
    if (!readers.result) throw new Error('A scalar outcome requires a usage reader');
    const observed = observe(readers.result(outcome.result as MeteredResult<Outcome>));
    return { outcome, usage: scope.createDeferred(async () => observed) };
  }

  if (!readers.stream) throw new Error('A stream outcome requires a usage reader');
  const reader = readers.stream();
  const observation = Promise.withResolvers<UsageObservation>();
  const usage = scope.createDeferred(() => observation.promise);
  const stream = scope.wrapStream(outcome.stream as Stream<MeteredEvent<Outcome>>, async function* (source, producer) {
    let reported = false;
    try {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          if (!reported) {
            if (item.error.kind === 'abort') {
              observation.resolve({ kind: 'local' });
            } else {
              const partial = reader.error?.(item.error);
              observation.resolve(partial === undefined ? { kind: 'upstream-error' } : observe(partial));
            }
          }
          producer.discard(source);
          yield item;
          return;
        }
        if (!reported) {
          const observed = reader.frame(item.value);
          if (observed !== undefined) {
            observation.resolve(observe(observed));
            reported = true;
          }
        }
        yield item;
      }
      if (!reported) observation.resolve(observe(reader.done()));
    } catch (error) {
      observation.reject(error);
      throw error;
    }
  });
  return { outcome: { ...outcome, stream }, usage };
};
