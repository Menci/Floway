import {
  abortChannelSubscription,
  channelSubscriptionQueueIsEmpty,
  channelSubscriptionQueuingStrategy,
  enqueueChannelValue,
  iterateReadableStream,
  type ChannelBroker,
  type ChannelCodec,
} from '@floway-dev/platform';

interface ChannelTarget {
  readonly events: EventTarget;
  subscribers: number;
}

// In-process per-channel fan-out backed by EventTarget. The Node deployment
// target only ever runs one worker process per gateway instance, so a Map of
// plain emitters is enough — no IPC, no cross-process broadcast.
export class EventTargetChannelBroker<T> implements ChannelBroker<T> {
  private readonly targets = new Map<string, ChannelTarget>();

  constructor(private readonly codec: ChannelCodec<T>) {}

  private acquireTarget(channelId: string): ChannelTarget {
    let target = this.targets.get(channelId);
    if (!target) {
      target = { events: new EventTarget(), subscribers: 0 };
      this.targets.set(channelId, target);
    }
    target.subscribers += 1;
    return target;
  }

  private releaseTarget(channelId: string, target: ChannelTarget): void {
    target.subscribers -= 1;
    if (target.subscribers === 0 && this.targets.get(channelId) === target) {
      this.targets.delete(channelId);
    }
  }

  async publish(channelId: string, payload: T): Promise<void> {
    const encoded = this.codec.encode(payload);
    this.targets.get(channelId)?.events.dispatchEvent(new CustomEvent('frame', { detail: encoded }));
  }

  async closeChannel(channelId: string, _reason: string): Promise<void> {
    const target = this.targets.get(channelId);
    if (!target) return;
    target.events.dispatchEvent(new Event('close'));
    this.targets.delete(channelId);
  }

  async subscribe(channelId: string, signal: AbortSignal): Promise<AsyncIterable<T>> {
    if (signal.aborted) return iterateReadableStream(closedStream<T>());
    const target = this.acquireTarget(channelId);
    return iterateReadableStream(streamFromTarget<T>(
      target.events,
      signal,
      this.codec,
      () => this.releaseTarget(channelId, target),
    ));
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
  onDetach: () => void,
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
        onDetach();
      };
      const close = (): void => {
        if (terminated) return;
        terminated = true;
        detach();
        controller.close();
      };
      const flushError = (): void => {
        if (
          !pendingError
          || !channelSubscriptionQueueIsEmpty(controller)
        ) return;
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
          enqueueChannelValue(controller, codec.decode((event as CustomEvent<string>).detail));
        } catch (error) {
          fail(error);
        }
      };
      const onClose = (): void => close();
      const onAbort = (): void => {
        if (terminated) return;
        terminated = true;
        detach();
        abortChannelSubscription(controller);
      };

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
  }, channelSubscriptionQueuingStrategy<T>());
};
