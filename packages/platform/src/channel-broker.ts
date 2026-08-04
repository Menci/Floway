// Per-channel publish/subscribe. The codec is supplied at construction so
// the channel transport stays unaware of the payload shape.

export interface ChannelCodec<T> {
  encode(value: T): string;
  decode(payload: string): T;
}

export interface ChannelBroker<T> {
  publish(channelId: string, payload: T): Promise<void>;
  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T>;
  closeChannel(channelId: string, reason: string): Promise<void>;
}

// The built-in ReadableStream async iterator serializes next() calls. A stream
// error can therefore reject the active call and complete a concurrently queued
// call. Channel consumers may issue concurrent reads, so each next() maps
// directly to the reader's pending-read queue, which rejects every read on
// error: https://streams.spec.whatwg.org/#default-reader-read
export const iterateReadableStream = <T>(stream: ReadableStream<T>): AsyncIterable<T> => ({
  [Symbol.asyncIterator]() {
    const reader = stream.getReader();
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      reader.releaseLock();
    };

    return {
      async next(): Promise<IteratorResult<T>> {
        if (!active) return { done: true, value: undefined };
        const result = await reader.read();
        if (result.done) release();
        return result;
      },
      async return(): Promise<IteratorResult<T>> {
        if (active) {
          try {
            await reader.cancel();
          } finally {
            release();
          }
        }
        return { done: true, value: undefined };
      },
    };
  },
});
