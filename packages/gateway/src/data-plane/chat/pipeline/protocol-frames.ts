import type { Result } from '@floway-dev/pipeline';
import { eventFrame, type ParsedProtocolFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

export const readProtocolFrames = <Event>(items: AsyncIterable<Result<Event, ProtocolStreamError>>) => {
  const cursor = items[Symbol.asyncIterator]();
  let done = false;
  let failure: ProtocolStreamError | undefined;

  const read = async () => {
    const item = await cursor.next();
    done = item.done === true;
    return item;
  };
  return {
    get done() { return done; },
    get failure() { return failure; },
    // Closing the frame iterator leaves the managed cursor available for its
    // owner to drain through native done.
    async *frames(): AsyncGenerator<ProtocolFrame<Event>> {
      while (!done) {
        const item = await read();
        if (item.done) return;
        if (!item.value.ok) {
          failure = item.value.error;
          throw failure;
        }
        yield eventFrame(item.value.value);
      }
    },
    async drain(): Promise<void> {
      while (!done) await read();
    },
  };
};

export const transformProtocolFrames = async function* <In, Out>(
  items: AsyncIterable<Result<In, ProtocolStreamError>>,
  transform: (
    frames: AsyncIterable<ProtocolFrame<In>>,
    failure: () => ProtocolStreamError | undefined,
  ) => AsyncIterable<ParsedProtocolFrame<Out>>,
  abort: () => void,
): AsyncGenerator<Result<Out, ProtocolStreamError>> {
  const source = readProtocolFrames(items);
  let failure: ProtocolStreamError | undefined;
  try {
    for await (const frame of transform(source.frames(), () => source.failure)) {
      if (frame.type === 'done') break;
      if (frame.type === 'error') {
        failure = { kind: 'protocol', cause: frame.cause };
        break;
      }
      yield { ok: true, value: frame.event };
    }
  } catch (cause) {
    if (source.failure === undefined || cause !== source.failure) throw cause;
    failure = source.failure;
  }
  if (!source.done) abort();
  if (failure !== undefined) yield { ok: false, error: failure };
  await source.drain();
};
