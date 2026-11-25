import type { Result } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
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
    // Legacy readers may close their frame iterator early. The managed cursor
    // remains open for its owner to drain through native done.
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
