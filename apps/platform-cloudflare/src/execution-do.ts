import { DurableObject } from 'cloudflare:workers';

import { responseFromExecutionSnapshot, snapshotExecutionResponse, type ExecutionResponseSnapshot } from '@floway-dev/platform';

export class ExecutionDO extends DurableObject {
  private execution: Promise<ExecutionResponseSnapshot> | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'GET') return this.subscribe(request);
    if (url.pathname === '/broadcast' && request.method === 'POST') return await this.broadcast(request);
    if (url.pathname === '/broadcast/close' && request.method === 'POST') return await this.closeAll(request);
    return await this.execute(request);
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

  private async execute(request: Request): Promise<Response> {
    if (this.execution === null) {
      const operation = this.ctx.exports.ExecutionOperationEntrypoint.fetch(request).then(snapshotExecutionResponse);
      this.execution = operation;
      void operation.then(
        () => { if (this.execution === operation) this.execution = null; },
        () => { if (this.execution === operation) this.execution = null; },
      );
      void operation.catch(error => console.error('ExecutionDO operation failed', error));
    }
    return responseFromExecutionSnapshot(await this.execution);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}
}
