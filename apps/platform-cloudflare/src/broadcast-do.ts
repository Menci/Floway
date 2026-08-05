import { DurableObject } from 'cloudflare:workers';

// `extends DurableObject` is load-bearing: the CF runtime gates RPC method
// dispatch (`stub.broadcast(...)`, `stub.closeAll(...)`) on the actor
// extending this base class. Without it the runtime rejects the call with
// "the receiving Durable Object does not support RPC" and any caller using
// direct method invocation silently fails.

export class BroadcastDO extends DurableObject {
  // Declared explicitly so the type-check sees `(ctx, env)` even when the
  // `cloudflare:workers` types resolve to a parameterless base.
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    // A failed 101 upgrade can leave its accepted server half registered with
    // the actor, so validate before constructing the pair. This is also the
    // ordering prescribed by Cloudflare's Durable Object WebSocket flow:
    // https://github.com/cloudflare/cloudflare-docs/blob/3e0c76c79bf00f17bb56b978242402dc712503b2/src/content/docs/durable-objects/best-practices/websockets.mdx#L403-L412
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, {
        status: 426,
        statusText: 'Expected Upgrade: websocket',
        headers: { Upgrade: 'websocket' },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(payload: string): Promise<void> {
    attemptEveryWebSocket(this.ctx.getWebSockets(), 'broadcast', ws => ws.send(payload));
  }

  async closeAll(reason: string): Promise<void> {
    attemptEveryWebSocket(this.ctx.getWebSockets(), 'closeAll', ws => ws.close(1000, reason));
  }

  // Hibernation hooks. With compatibility_date < 2026-04-07 the runtime
  // delivers close events only when these hooks are declared on the actor,
  // and `webSocketClose` must call `ws.close(code, reason)` to complete the
  // close handshake from the actor side — without it the client sees a
  // `1006 abnormal closure` and the actor holds the dead socket until the
  // hibernation timeout.
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }
  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}
}

type WebSocketOperation = 'broadcast' | 'closeAll';

// A failed connection must not prevent later sockets in the registry snapshot
// from receiving the operation. Cloudflare's reference actor likewise isolates
// each send before continuing its fan-out:
// https://github.com/cloudflare/workers-chat-demo/blob/dd32ce87617a9df6c614004d2fc2fb0628698121/src/chat.mjs#L424-L456
const attemptEveryWebSocket = (
  sockets: readonly WebSocket[],
  operationName: WebSocketOperation,
  operation: (socket: WebSocket) => void,
): void => {
  const errors: unknown[] = [];
  for (const socket of sockets) {
    try {
      operation(socket);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `BroadcastDO.${operationName} failed for ${errors.length} WebSocket connection(s)`);
  }
};
