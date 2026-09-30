import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export class LogStreamStorage {
  readonly database = new DatabaseSync(':memory:');
  alarm: number | null = null;
  readonly sql: SqlStorage = {
    exec: <T>(query: string, ...bindings: unknown[]) => {
      const statements = query.split(';').map(statement => statement.trim()).filter(Boolean);
      for (const statement of statements.slice(0, -1)) this.database.exec(statement);
      const statement = this.database.prepare(statements.at(-1)!);
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue[];
      const rows = statement.all(...values) as T[];
      return {
        [Symbol.iterator]: () => rows[Symbol.iterator](),
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one SQL row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(at: number): Promise<void> { this.alarm = at; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
  async deleteAll(): Promise<void> { this.database.exec('DROP TABLE IF EXISTS segments; DROP TABLE IF EXISTS stream_state;'); }
}

export class LogStreamSocket extends EventTarget {
  readonly sent: (string | Uint8Array)[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown;
  private accepted = false;
  private readonly queue: Event[] = [];
  peer: LogStreamSocket | undefined;

  serializeAttachment(value: unknown): void { this.attachment = value; }
  deserializeAttachment(): unknown { return this.attachment; }
  accept(): void { this.accepted = true; this.flush(); }
  send(value: string | ArrayBufferView): void {
    const data = typeof value === 'string' ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    this.sent.push(data);
    this.peer?.receive(new MessageEvent('message', { data: typeof data === 'string' ? data : data.buffer }));
  }
  close(code = 1000, reason = ''): void {
    if (this.closed !== null) return;
    this.closed = { code, reason };
    const event = Object.assign(new Event('close'), { code, reason });
    this.peer?.receive(event);
  }
  private receive(event: Event): void { this.queue.push(event); this.flush(); }
  private flush(): void {
    if (!this.accepted) return;
    queueMicrotask(() => {
      while (this.queue.length > 0) this.dispatchEvent(this.queue.shift()!);
    });
  }
}

export class LogStreamState implements DurableObjectState {
  readonly storage = new LogStreamStorage();
  readonly sockets: LogStreamSocket[] = [];
  readonly exports = { ExecutionOperationEntrypoint: { fetch: async () => new Response() } };
  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> { return await callback(); }
  acceptWebSocket(socket: WebSocket): void { this.sockets.push(socket as unknown as LogStreamSocket); }
  getWebSockets(): WebSocket[] { return this.sockets.filter(socket => socket.closed === null) as unknown as WebSocket[]; }
}

export class LogStreamWebSocketPair {
  readonly 0 = new LogStreamSocket();
  readonly 1 = new LogStreamSocket();
  constructor() { this[0].peer = this[1]; this[1].peer = this[0]; }
}

const NativeResponse = Response;
export class LogStreamResponse extends NativeResponse {
  readonly webSocket?: WebSocket;
  private readonly responseStatus: number;
  constructor(body?: BodyInit | null, init: ResponseInit = {}) {
    super(body, init.status === 101 ? { ...init, status: 200 } : init);
    this.responseStatus = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
  override get status(): number { return this.responseStatus; }
}
