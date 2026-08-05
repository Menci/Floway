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
    let state: 'open' | 'terminal' | 'released' = 'open';
    let pendingReads = 0;
    let cancellation: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null;
    let resolveReleased!: () => void;
    const released = new Promise<void>(resolve => { resolveReleased = resolve; });
    const releaseWhenIdle = (): void => {
      if (state !== 'terminal' || pendingReads !== 0) return;
      state = 'released';
      reader.releaseLock();
      resolveReleased();
    };

    return {
      async next(): Promise<IteratorResult<T>> {
        if (state !== 'open') return { done: true, value: undefined };
        pendingReads += 1;
        try {
          const result = await reader.read();
          if (result.done) state = 'terminal';
          return result;
        } catch (error) {
          state = 'terminal';
          throw error;
        } finally {
          pendingReads -= 1;
          releaseWhenIdle();
        }
      },
      async return(value?: unknown): Promise<IteratorResult<T>> {
        if (state === 'open') {
          cancellation = reader.cancel(value).then(
            () => ({ ok: true as const }),
            error => ({ ok: false as const, error }),
          );
          state = 'terminal';
          releaseWhenIdle();
        }
        if (state !== 'released') await released;
        if (cancellation) {
          const result = await cancellation;
          if (!result.ok) throw result.error;
        }
        return { done: true, value };
      },
    };
  },
});
