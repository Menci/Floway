declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  import type { WebSocketLike, WebSocketServerLike } from '@hono/node-server';

  export class WebSocketServer implements WebSocketServerLike {
    constructor(options: { noServer: true });
    readonly options: { noServer?: boolean };
    on(event: 'connection', listener: (ws: WebSocketLike, request: IncomingMessage) => void): this;
    on(event: 'headers', listener: (headers: string[]) => void): this;
    off(event: 'headers', listener: (headers: string[]) => void): this;
    emit(event: 'connection', ws: WebSocketLike, request: IncomingMessage): boolean;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocketLike) => void): void;
    close(): void;
  }
}
