import {
  abortChannelSubscription,
  channelSubscriptionQueueIsEmpty,
  channelSubscriptionQueuingStrategy,
  enqueueChannelValue,
  iterateReadableStream,
  type ChannelBroker,
  type ChannelCodec,
} from '@floway-dev/platform';

// Minimal namespace surface for BROADCAST_DO — declared locally so this
// file stays off `@cloudflare/workers-types`.
export interface BroadcastNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): BroadcastStub;
}

interface BroadcastStub {
  broadcast(payload: string): Promise<void>;
  closeAll(reason: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

export class DurableObjectChannelBroker<T> implements ChannelBroker<T> {
  constructor(
    private readonly namespace: BroadcastNamespace,
    private readonly codec: ChannelCodec<T>,
  ) {}

  private stub(channelId: string): BroadcastStub {
    return this.namespace.get(this.namespace.idFromName(channelId));
  }

  async publish(channelId: string, payload: T): Promise<void> {
    await this.stub(channelId).broadcast(this.codec.encode(payload));
  }

  async closeChannel(channelId: string, reason: string): Promise<void> {
    await this.stub(channelId).closeAll(reason);
  }

  async subscribe(channelId: string, signal: AbortSignal): Promise<AsyncIterable<T>> {
    const opening = iterateFromBroadcastSocket<T>(this.stub(channelId), signal, this.codec);
    try {
      await opening.opened;
    } catch (error) {
      if (signal.aborted) return iterateReadableStream(closedStream<T>());
      throw error;
    }
    return iterateReadableStream(opening.stream);
  }
}

const closedStream = <T>(): ReadableStream<T> => new ReadableStream({
  start: controller => controller.close(),
});

interface OpeningBroadcastStream<T> {
  readonly stream: ReadableStream<T>;
  readonly opened: Promise<void>;
}

// subscribe() awaits `opened`, so callers can finish the transport handshake
// before taking a snapshot whose live handoff depends on this listener already
// being registered.
const iterateFromBroadcastSocket = <T>(
  stub: BroadcastStub,
  signal: AbortSignal,
  codec: ChannelCodec<T>,
): OpeningBroadcastStream<T> => {
  let cancel = async (): Promise<void> => {};
  let pull = (): void => {};
  let opened!: Promise<void>;

  const stream = new ReadableStream<T>({
    start(controller) {
      if (signal.aborted) {
        controller.close();
        opened = Promise.resolve();
        return;
      }

      let socket: WebSocket | null = null;
      let terminated = false;
      let pendingError: { error: unknown } | null = null;

      const detach = (): void => {
        signal.removeEventListener('abort', onAbort);
        socket?.removeEventListener('message', onMessage);
        socket?.removeEventListener('close', onClose);
        socket?.removeEventListener('error', onError);
      };
      // Subscriber termination must remove its WebSocket from the Durable
      // Object hibernation registry. Waiting for the eager open also covers a
      // cancellation or error that arrives while the handshake is in flight.
      const closeSocket = async (): Promise<void> => {
        await openPromise.catch(() => {});
        socket?.close(1000, 'subscriber done');
      };
      const close = (closeUpstream = true): void => {
        if (terminated) return;
        terminated = true;
        detach();
        controller.close();
        if (closeUpstream) void closeSocket();
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
      const fail = (error: unknown, closeUpstream = true): void => {
        if (terminated) return;
        terminated = true;
        detach();
        pendingError = { error };
        flushError();
        if (closeUpstream) void closeSocket();
      };
      const onMessage = (event: MessageEvent): void => {
        if (terminated) return;
        try {
          const raw = event.data as string | ArrayBuffer;
          const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
          enqueueChannelValue(controller, codec.decode(text));
        } catch (error) {
          fail(error);
        }
      };
      const onClose = (event: CloseEvent): void => {
        try {
          socket?.close(event.code, event.reason);
          close(false);
        } catch (error) {
          fail(error, false);
        }
      };
      const onError = (): void => fail(new Error('BroadcastDO socket error'));
      const onAbort = (): void => {
        if (terminated) return;
        terminated = true;
        detach();
        abortChannelSubscription(controller);
        void closeSocket();
      };

      cancel = async (): Promise<void> => {
        if (terminated) return;
        terminated = true;
        detach();
        await closeSocket();
      };
      pull = flushError;

      const openPromise = (async (): Promise<void> => {
        const response = await stub.fetch(new Request('https://broadcast.do/subscribe', {
          headers: { Upgrade: 'websocket' },
          signal,
        }));
        if (response.status !== 101) {
          throw new Error(`BroadcastDO subscribe returned HTTP ${response.status} instead of 101`);
        }
        const openedSocket = response.webSocket;
        if (!openedSocket) throw new Error('BroadcastDO returned 101 without a webSocket');

        socket = openedSocket;
        if (!terminated) {
          socket.addEventListener('message', onMessage);
          socket.addEventListener('close', onClose);
          socket.addEventListener('error', onError);
        }
        socket.accept();
      })();
      opened = openPromise.catch(error => {
        fail(error);
        throw error;
      });
      signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel: () => cancel(),
    pull: () => pull(),
  }, channelSubscriptionQueuingStrategy<T>());
  return { stream, opened };
};
