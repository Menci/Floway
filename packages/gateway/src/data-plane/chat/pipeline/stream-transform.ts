import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/upstream';

type Stream<Event> = ManagedStream<Event, ProtocolStreamError>;
type Items<Event> = AsyncGenerator<Result<Event, ProtocolStreamError>, void, unknown>;

interface StreamReader<Event> {
  read(stream: Stream<Event>): AsyncIterableIterator<Result<Event, ProtocolStreamError>>;
  discard(stream: Stream<Event>): void;
}

export const mapProtocolEvents = async function* <Input, Output>(
  source: Stream<Input>,
  producer: StreamReader<Input>,
  map: (event: Input) => Output | undefined,
  mapError?: (error: ProtocolStreamError) => ProtocolStreamError | Promise<ProtocolStreamError>,
): Items<Output> {
  for await (const item of producer.read(source)) {
    if (!item.ok) {
      producer.discard(source);
      yield mapError === undefined ? item : { ok: false, error: await mapError(item.error) };
      return;
    }
    const value = map(item.value);
    if (value !== undefined) yield { ok: true, value };
  }
};

export const transformProtocolFrames = async function* <Input, Output>(
  source: Stream<Input>,
  producer: StreamReader<Input>,
  transform: (frames: AsyncIterable<ProtocolFrame<Input>>) => AsyncIterable<ProtocolFrame<Output>>,
): Items<Output> {
  const cursor = producer.read(source);
  let exhausted = false;
  let failure: ProtocolStreamError | undefined;
  const frames: AsyncIterable<ProtocolFrame<Input>> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const item = await cursor.next();
        if (item.done) {
          exhausted = true;
          return { done: true, value: undefined };
        }
        if (item.value.ok) return { done: false, value: eventFrame(item.value.value) };

        exhausted = true;
        failure = item.value.error;
        producer.discard(source);
        return { done: true, value: undefined };
      },
    }),
  };
  for await (const frame of transform(frames)) {
    if (frame.type === 'event') yield { ok: true, value: frame.event };
  }
  // An event transform may stop on a protocol terminal before the transport
  // has proved native completion. The live cursor still owns that evidence.
  while (!exhausted) {
    const item = await cursor.next();
    if (item.done) break;
    if (!item.value.ok) {
      failure = item.value.error;
      producer.discard(source);
      break;
    }
  }
  if (failure !== undefined) yield { ok: false, error: failure };
};

interface ItemEvent {
  readonly index: number;
  readonly kind: 'start' | 'delta' | 'end';
}

interface QueuedEvent<Event> {
  event: Event;
  bytes: number;
}

const maxInterleavedEvents = 4096;
const maxInterleavedBytes = 64 * 1024 * 1024;
const encoder = new TextEncoder();

export const serializeProtocolItems = async function* <Event>(
  source: Stream<Event>,
  producer: StreamReader<Event>,
  describe: (event: Event) => ItemEvent | undefined,
  project: (event: Event) => Event,
  projectError?: (error: ProtocolStreamError) => ProtocolStreamError,
): Items<Event> {
  let active: number | undefined;
  let queued: QueuedEvent<Event>[] = [];
  let pendingCount = 0;
  let bytes = 0;
  for await (const item of producer.read(source)) {
    if (!item.ok) {
      producer.discard(source);
      yield projectError === undefined ? item : { ok: false, error: projectError(item.error) };
      return;
    }

    // Replay a deferred batch only when its current item closes.
    const batches: { events: (QueuedEvent<Event> | undefined)[]; cursor: number }[] = [];
    let pending: QueuedEvent<Event> | undefined = { event: item.value, bytes: 0 };
    while (pending !== undefined) {
      const { event } = pending;
      const described = describe(event);
      const blocked = described === undefined ? queued.length > 0 : described.index !== active;
      if (active !== undefined && blocked) {
        const eventBytes = pending.bytes || encoder.encode(JSON.stringify(event)).byteLength;
        bytes += eventBytes;
        pendingCount++;
        if (pendingCount > maxInterleavedEvents || bytes > maxInterleavedBytes) {
          throw new RangeError(`Interleaved output exceeds ${maxInterleavedEvents} events or ${maxInterleavedBytes} bytes`);
        }
        queued.push({ event, bytes: eventBytes });
      } else {
        if (described?.kind === 'start') active = described.index;
        yield { ok: true, value: project(event) };
        if (described?.kind === 'end') {
          active = undefined;
          if (queued.length > 0) {
            batches.push({ events: queued, cursor: 0 });
            queued = [];
          }
        }
      }

      pending = undefined;
      while (batches.length > 0 && pending === undefined) {
        const batch = batches.at(-1)!;
        if (batch.cursor === batch.events.length) {
          batches.pop();
        } else {
          pending = batch.events[batch.cursor]!;
          batch.events[batch.cursor++] = undefined;
          bytes -= pending.bytes;
          pendingCount--;
        }
      }
    }
  }
  if (queued.length > 0) throw new Error('Cannot serialize an interleaved stream whose active item never closed');
};
