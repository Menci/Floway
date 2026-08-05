import { iterateReadableStream, type ChannelBroker, type ChannelCodec } from '@floway-dev/platform';

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
    if (signal.aborted) return iterateReadableStream(closedStream<T>());
    return iterateReadableStream(streamFromTarget<T>(this.targetFor(channelId), signal, this.codec));
  }
}

const closedStream = <T>(): ReadableStream<T> => new ReadableStream({
  start: controller => controller.close(),
});

// Listener registration happens eagerly inside `streamFromTarget` so that a
// caller who awaits subscribe and then publishes before draining the iterator
// still receives the buffered frame. A generator that registers in its body
// would miss the publish because the body doesn't run until the first
// `.next()` call.
const streamFromTarget = <T>(
  target: EventTarget,
  signal: AbortSignal,
  codec: ChannelCodec<T>,
): ReadableStream<T> => {
  let cancel = (): void => {};
  let pull = (): void => {};

  return new ReadableStream<T>({
    start(controller) {
      let terminated = false;
      let pendingError: { error: unknown } | null = null;

      const detach = (): void => {
        target.removeEventListener('frame', onFrame);
        target.removeEventListener('close', onClose);
        signal.removeEventListener('abort', onAbort);
      };
      const close = (): void => {
        if (terminated) return;
        terminated = true;
        detach();
        controller.close();
      };
      const flushError = (): void => {
        if (!pendingError || (controller.desiredSize ?? 0) <= 0) return;
        const { error } = pendingError;
        pendingError = null;
        controller.error(error);
      };
      const fail = (error: unknown): void => {
        if (terminated) return;
        terminated = true;
        detach();
        pendingError = { error };
        flushError();
      };
      const onFrame = (event: Event): void => {
        if (terminated) return;
        try {
          controller.enqueue(codec.decode((event as CustomEvent<string>).detail));
        } catch (error) {
          fail(error);
        }
      };
      const onClose = (): void => close();
      const onAbort = (): void => close();

      cancel = (): void => {
        if (terminated) return;
        terminated = true;
        detach();
      };
      pull = flushError;

      target.addEventListener('frame', onFrame);
      target.addEventListener('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel: () => cancel(),
    pull: () => pull(),
  });
};
