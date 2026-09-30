import { DurableObject } from 'cloudflare:workers';

import type { LogStreamAppendResult } from './log-stream-contract.ts';
import { LOG_STREAM_IDLE_MS } from '@floway-dev/platform';

const SEGMENT_BYTES = 64 * 1024;
interface StreamState { length: number; ended: number; last_activity: number }
interface ReaderState { offset: number }

export class LogStreamDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) { super(ctx, env); }

  private sql(): SqlStorage { return this.ctx.storage.sql; }

  private state(): StreamState | null {
    const tables = [...this.sql().exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stream_state'")];
    if (tables.length === 0) return null;
    return this.sql().exec<StreamState>('SELECT length, ended, last_activity FROM stream_state WHERE id = 0').one();
  }

  async open(): Promise<void> {
    const state = this.state();
    if (state !== null && Date.now() - state.last_activity < LOG_STREAM_IDLE_MS) return;
    if (state !== null) await this.expire();
    this.sql().exec(`
      CREATE TABLE segments (start_offset INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE stream_state (
        id INTEGER PRIMARY KEY CHECK (id = 0), length INTEGER NOT NULL,
        ended INTEGER NOT NULL, last_activity INTEGER NOT NULL
      );
      INSERT INTO stream_state (id, length, ended, last_activity) VALUES (0, 0, 0, ?);
    `, Date.now());
    await this.armAlarm(Date.now() + LOG_STREAM_IDLE_MS);
  }

  async exists(): Promise<boolean> {
    const state = this.state();
    if (state === null) return false;
    if (Date.now() - state.last_activity < LOG_STREAM_IDLE_MS) return true;
    await this.expire();
    return false;
  }

  async append(atOffset: number, bytes: ArrayBuffer): Promise<LogStreamAppendResult> {
    const state = this.state();
    if (state === null) return { kind: 'expired' };
    if (atOffset > state.length) return { kind: 'hole', length: state.length };
    const incoming = new Uint8Array(bytes);
    const fresh = incoming.subarray(state.length - atOffset);
    if (state.ended === 1 && fresh.byteLength > 0) return { kind: 'ended' };
    let length = state.length;
    for (let cursor = 0; cursor < fresh.byteLength; cursor += SEGMENT_BYTES) {
      const segment = fresh.subarray(cursor, cursor + SEGMENT_BYTES);
      this.sql().exec('INSERT INTO segments (start_offset, bytes) VALUES (?, ?)', length, segment);
      length += segment.byteLength;
    }
    this.sql().exec('UPDATE stream_state SET length = ?, last_activity = ? WHERE id = 0', length, Date.now());
    for (const socket of this.ctx.getWebSockets()) this.pump(socket);
    return { kind: 'appended' };
  }

  async end(): Promise<'ended' | 'expired'> {
    if (this.state() === null) return 'expired';
    this.sql().exec('UPDATE stream_state SET ended = 1, last_activity = ? WHERE id = 0', Date.now());
    for (const socket of this.ctx.getWebSockets()) {
      this.pump(socket);
      socket.close(1000, 'ended');
    }
    return 'ended';
  }

  async fetch(request: Request): Promise<Response> {
    const fromOffset = Number(new URL(request.url).searchParams.get('fromOffset') ?? '0');
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) return new Response('fromOffset must be a non-negative safe integer', { status: 400 });
    if (!await this.exists()) return new Response('LogStream not found', { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ offset: fromOffset } satisfies ReaderState);
    this.pump(server);
    if (this.state()!.ended === 1) server.close(1000, 'ended');
    return new Response(null, { status: 101, webSocket: client });
  }

  private pump(socket: WebSocket): void {
    const reader = socket.deserializeAttachment() as ReaderState;
    const state = this.state()!;
    let offset = reader.offset;
    while (offset < state.length) {
      const segment = this.sql().exec<{ start_offset: number; bytes: ArrayBuffer }>(
        'SELECT start_offset, bytes FROM segments WHERE start_offset <= ? ORDER BY start_offset DESC LIMIT 1', offset,
      ).one();
      const bytes = new Uint8Array(segment.bytes).subarray(offset - segment.start_offset);
      socket.send(bytes);
      offset += bytes.byteLength;
    }
    socket.serializeAttachment({ offset } satisfies ReaderState);
    this.sql().exec('UPDATE stream_state SET last_activity = ? WHERE id = 0', Date.now());
  }

  private async armAlarm(at: number): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const state = this.state();
    if (state === null) return;
    const expiresAt = state.last_activity + LOG_STREAM_IDLE_MS;
    if (Date.now() < expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    await this.expire();
  }

  private async expire(): Promise<void> {
    // Reset is serialized against new opens, and both calls are necessary on
    // compatibility dates where deleteAll does not also delete the alarm.
    // https://developers.cloudflare.com/durable-objects/api/alarms/
    await this.ctx.blockConcurrencyWhile(async () => {
      for (const socket of this.ctx.getWebSockets()) socket.close(1012, 'expired');
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    });
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> { socket.close(code, reason); }
  async webSocketError(_socket: WebSocket, _error: unknown): Promise<void> {}
}
