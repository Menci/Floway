// workerd's WebSocket upgrade has no standard equivalent: `WebSocketPair` is a
// runtime global, and the 101 response carries the client half in a
// non-standard `webSocket` init field. Tests that drive an upgrade handler
// install both here and read back the pairs the handler created.
type WorkerResponseInit = ResponseInit & { readonly webSocket?: WebSocket };

export class TestWorkerWebSocket extends EventTarget {
  peer?: TestWorkerWebSocket;
  readyState: number = WebSocket.OPEN;

  accept(): void {}

  send(data: string): void {
    this.peer?.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    if (this.peer) {
      this.peer.readyState = WebSocket.CLOSED;
      this.peer.dispatchEvent(new Event('close'));
    }
  }
}

export const installWorkerWebSocketRuntime = (): {
  readonly pairs: Array<{ readonly client: TestWorkerWebSocket; readonly server: TestWorkerWebSocket }>;
  restore(): void;
} => {
  const globals = globalThis as typeof globalThis & {
    WebSocketPair?: unknown;
    Response: typeof Response;
  };
  const originalWebSocketPair = globals.WebSocketPair;
  const OriginalResponse = globals.Response;
  const pairs: Array<{ readonly client: TestWorkerWebSocket; readonly server: TestWorkerWebSocket }> = [];

  globals.WebSocketPair = class {
    constructor() {
      const client = new TestWorkerWebSocket();
      const server = new TestWorkerWebSocket();
      client.peer = server;
      server.peer = client;
      pairs.push({ client, server });
      return { 0: client, 1: server };
    }
  };

  globals.Response = class extends OriginalResponse {
    constructor(body?: BodyInit | null, init?: WorkerResponseInit) {
      // The standard constructor rejects any status outside 200-599 with a
      // RangeError (https://fetch.spec.whatwg.org/#dom-response), so a 101
      // upgrade is built at 200 and then redefined.
      if (init?.status === 101) {
        const { webSocket, status: _status, ...rest } = init;
        super(null, { ...rest, status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        Object.defineProperty(this, 'webSocket', { value: webSocket });
        return;
      }
      super(body, init);
    }
  };

  return {
    pairs,
    restore: () => {
      globals.WebSocketPair = originalWebSocketPair;
      globals.Response = OriginalResponse;
    },
  };
};
