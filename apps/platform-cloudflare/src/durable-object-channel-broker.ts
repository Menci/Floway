import { iterateReadableStream, type ChannelBroker, type ChannelCodec } from '@floway-dev/platform';

export interface ExecutionDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const fetchBroadcastStub = (
  namespace: ExecutionDurableObjectNamespace,
  channelId: string,
  request: Request,
): Promise<Response> =>
  namespace.get(namespace.idFromName(JSON.stringify(['broadcast', channelId]))).fetch(request);

export class DurableObjectChannelBroker<T> implements ChannelBroker<T> {
  constructor(
    private readonly namespace: ExecutionDurableObjectNamespace,
    private readonly codec: ChannelCodec<T>,
  ) {}

  async publish(channelId: string, payload: T): Promise<void> {
    const response = await fetchBroadcastStub(this.namespace, channelId, new Request('https://execution.do/broadcast', {
      method: 'POST',
      body: this.codec.encode(payload),
    }));
    if (!response.ok) throw new Error(`ExecutionDO broadcast returned HTTP ${response.status}`);
  }

  async closeChannel(channelId: string, reason: string): Promise<void> {
    const response = await fetchBroadcastStub(this.namespace, channelId, new Request('https://execution.do/broadcast/close', {
      method: 'POST',
      body: reason,
    }));
    if (!response.ok) throw new Error(`ExecutionDO close returned HTTP ${response.status}`);
  }

  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T> {
    return iterateReadableStream(iterateFromExecutionSocket(this.namespace, channelId, signal, this.codec));
  }
}

const iterateFromExecutionSocket = <T>(
  namespace: ExecutionDurableObjectNamespace,
  channelId: string,
  signal: AbortSignal,
  codec: ChannelCodec<T>,
): ReadableStream<T> => {
  let cancel = async (): Promise<void> => {};
  let pull = (): void => {};

  return new ReadableStream<T>({
    start(controller) {
      if (signal.aborted) {
        controller.close();
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
        if (!pendingError || (controller.desiredSize ?? 0) <= 0) return;
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
          controller.enqueue(codec.decode(text));
        } catch (error) {
          fail(error);
        }
      };
      const onClose = (): void => close(false);
      const onError = (): void => fail(new Error('ExecutionDO socket error'));
      const onAbort = (): void => close();

      cancel = async (): Promise<void> => {
        if (terminated) return;
        terminated = true;
        detach();
        await closeSocket();
      };
      pull = flushError;

      const openPromise = (async (): Promise<void> => {
        const response = await fetchBroadcastStub(namespace, channelId, new Request('https://execution.do/broadcast', {
          headers: { Upgrade: 'websocket' },
        }));
        if (response.status !== 101) {
          throw new Error(`ExecutionDO subscribe returned HTTP ${response.status} instead of 101`);
        }
        const openedSocket = response.webSocket;
        if (!openedSocket) throw new Error('ExecutionDO returned 101 without a webSocket');

        socket = openedSocket;
        if (!terminated) {
          socket.addEventListener('message', onMessage);
          socket.addEventListener('close', onClose);
          socket.addEventListener('error', onError);
        }
        socket.accept();
      })();
      signal.addEventListener('abort', onAbort, { once: true });
      void openPromise.catch(error => fail(error, false));
    },
    cancel: () => cancel(),
    pull: () => pull(),
  });
};
