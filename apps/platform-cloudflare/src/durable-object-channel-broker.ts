import type { ChannelBroker, ChannelCodec } from '@floway-dev/platform';

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

  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T> {
    return iterateFromBroadcastSocket<T>(this.stub(channelId), signal, this.codec);
  }
}

// Listener registration and socket open run eagerly so a broadcast that races
// against the iterator drain still buffers into the queue and lands on the
// next read.
const iterateFromBroadcastSocket = <T>(
  stub: BroadcastStub,
  signal: AbortSignal,
  codec: ChannelCodec<T>,
): ReadableStream<T> => {
  let cancel = async (): Promise<void> => {};

  return new ReadableStream<T>({
    start(controller) {
      if (signal.aborted) {
        controller.close();
        return;
      }

      let socket: WebSocket | null = null;
      let terminated = false;

      const detach = (): void => {
        signal.removeEventListener('abort', onAbort);
        socket?.removeEventListener('message', onMessage);
        socket?.removeEventListener('close', onClose);
        socket?.removeEventListener('error', onError);
      };
      const openPromise = (async (): Promise<void> => {
        const response = await stub.fetch(new Request('https://broadcast.do/subscribe', {
          headers: { Upgrade: 'websocket' },
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
      const closeSocket = async (): Promise<void> => {
        await openPromise.catch(() => {});
        socket?.close(1000, 'subscriber done');
      };
      const finish = (error?: unknown, closeUpstream = true): void => {
        if (terminated) return;
        terminated = true;
        detach();
        if (error === undefined) controller.close();
        else controller.error(error);
        if (closeUpstream) void closeSocket();
      };
      const onMessage = (event: MessageEvent): void => {
        if (terminated) return;
        try {
          const raw = event.data as string | ArrayBuffer;
          const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
          controller.enqueue(codec.decode(text));
        } catch (error) {
          finish(error);
        }
      };
      const onClose = (): void => finish(undefined, false);
      const onError = (): void => finish(new Error('BroadcastDO socket error'));
      const onAbort = (): void => finish();

      cancel = async (): Promise<void> => {
        if (terminated) return;
        terminated = true;
        detach();
        await closeSocket();
      };

      signal.addEventListener('abort', onAbort, { once: true });
      void openPromise.catch(error => finish(error, false));
    },
    cancel: () => cancel(),
  });
};
