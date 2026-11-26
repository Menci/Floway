import { DurableObject } from 'cloudflare:workers';

export class ExecutionDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'GET') return this.subscribe(request);
    if (url.pathname === '/broadcast' && request.method === 'POST') return await this.broadcast(request);
    if (url.pathname === '/broadcast/close' && request.method === 'POST') return await this.closeAll(request);
    return new Response('Not found', { status: 404 });
  }

  private subscribe(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const [client, server] = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(request: Request): Promise<Response> {
    const payload = await request.text();
    for (const ws of this.ctx.getWebSockets()) ws.send(payload);
    return new Response(null, { status: 204 });
  }

  private async closeAll(request: Request): Promise<Response> {
    const reason = await request.text();
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, reason);
    return new Response(null, { status: 204 });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}
}
