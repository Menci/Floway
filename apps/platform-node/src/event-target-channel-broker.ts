import type { ChannelBroker, ChannelCodec } from '@floway-dev/platform';

// In-process per-channel fan-out backed by EventTarget. The Node deployment
// target only ever runs one worker process per gateway instance, so a Map of
// plain emitters is enough — no IPC, no cross-process broadcast.
export class EventTargetChannelBroker<T> implements ChannelBroker<T> {
  private readonly targets = new Map<string, EventTarget>();

  constructor(private readonly codec: ChannelCodec<T>) {}

  private targetFor(channelId: string): EventTarget {
    let target = this.targets.get(channelId);
    if (!target) {
      target = new EventTarget();
      this.targets.set(channelId, target);
    }
    return target;
  }

  async publish(channelId: string, payload: T): Promise<void> {
    this.targetFor(channelId).dispatchEvent(new CustomEvent('frame', { detail: this.codec.encode(payload) }));
  }

  async closeChannel(channelId: string, _reason: string): Promise<void> {
    const target = this.targets.get(channelId);
    if (!target) return;
    target.dispatchEvent(new Event('close'));
    this.targets.delete(channelId);
  }

  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T> {
    return iterateFromTarget<T>(this.targetFor(channelId), signal, this.codec);
  }
}

// Listener registration happens eagerly inside `iterateFromTarget` so that a
// caller who awaits subscribe and then publishes before draining the iterator
// still receives the buffered frame. A generator that registers in its body
// would miss the publish because the body doesn't run until the first
// `.next()` call.
const iterateFromTarget = <T>(
  target: EventTarget,
  signal: AbortSignal,
  codec: ChannelCodec<T>,
): AsyncIterable<T> => {
  const queue: T[] = [];
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  let closed = false;

  const deliver = (value: IteratorResult<T>): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(value);
    } else if (!value.done) {
      queue.push(value.value);
    }
  };

  const onFrame = (event: Event): void => {
    if (closed) return;
    const payload = (event as CustomEvent<string>).detail;
    deliver({ value: codec.decode(payload), done: false });
  };
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    detach();
    deliver({ value: undefined as never, done: true });
  };
  const onAbort = (): void => {
    if (closed) return;
    closed = true;
    detach();
    deliver({ value: undefined as never, done: true });
  };
  const detach = (): void => {
    target.removeEventListener('frame', onFrame);
    target.removeEventListener('close', onClose);
    signal.removeEventListener('abort', onAbort);
  };

  target.addEventListener('frame', onFrame);
  target.addEventListener('close', onClose);
  signal.addEventListener('abort', onAbort, { once: true });

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
      async next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (closed) return { value: undefined as never, done: true };
        return await new Promise<IteratorResult<T>>(resolve => { resolveNext = resolve; });
      },
      async return(): Promise<IteratorResult<T>> {
        if (!closed) {
          closed = true;
          detach();
        }
        return { value: undefined as never, done: true };
      },
    }),
  };
};
