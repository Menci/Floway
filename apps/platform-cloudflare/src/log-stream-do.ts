/// <reference path="./cloudflare-workers.d.ts" />

import { DurableObject } from 'cloudflare:workers';

import type { LogStreamAppendResult, LogStreamReadResult } from './log-stream-contract.ts';
import { LOG_STREAM_IDLE_MS } from '@floway-dev/platform';

const SEGMENT_BYTES = 64 * 1024;

interface StreamState {
  length: number;
  ended: number;
  last_activity: number;
}

const assertOffset = (offset: number, name: string): void => {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
};

export class LogStreamDO extends DurableObject {
  private sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private state(): StreamState | null {
    const tables = [...this.sql().exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stream_state'",
    )];
    if (tables.length === 0) return null;
    return this.sql().exec<StreamState>(
      'SELECT length, ended, last_activity FROM stream_state WHERE id = 0',
    ).one();
  }

  async open(): Promise<void> {
    const state = this.state();
    if (state !== null && Date.now() - state.last_activity < LOG_STREAM_IDLE_MS) return;
    if (state !== null) await this.expire();

    this.sql().exec(`
      CREATE TABLE segments (start_offset INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE stream_state (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        length INTEGER NOT NULL,
        ended INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
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
    assertOffset(atOffset, 'LogStream append offset');
    const state = this.state();
    if (state === null) return { kind: 'expired' };
    if (atOffset > state.length) return { kind: 'hole', length: state.length };

    const fresh = new Uint8Array(bytes, 0, bytes.byteLength).subarray(state.length - atOffset);
    if (state.ended === 1 && fresh.byteLength > 0) return { kind: 'ended' };
    if (fresh.byteLength === 0) {
      this.sql().exec('UPDATE stream_state SET last_activity = ? WHERE id = 0', Date.now());
      return { kind: 'appended' };
    }

    let length = state.length;
    let cursor = 0;
    while (cursor < fresh.byteLength) {
      const segmentOffset = length % SEGMENT_BYTES;
      if (segmentOffset !== 0) {
        const startOffset = length - segmentOffset;
        const row = this.sql().exec<{ bytes: ArrayBuffer }>(
          'SELECT bytes FROM segments WHERE start_offset = ?',
          startOffset,
        ).one();
        const existing = new Uint8Array(row.bytes);
        const take = Math.min(SEGMENT_BYTES - existing.byteLength, fresh.byteLength - cursor);
        const extended = new Uint8Array(existing.byteLength + take);
        extended.set(existing);
        extended.set(fresh.subarray(cursor, cursor + take), existing.byteLength);
        this.sql().exec('UPDATE segments SET bytes = ? WHERE start_offset = ?', extended, startOffset);
        cursor += take;
        length += take;
      } else {
        const segment = fresh.subarray(cursor, cursor + SEGMENT_BYTES);
        this.sql().exec('INSERT INTO segments (start_offset, bytes) VALUES (?, ?)', length, segment);
        cursor += segment.byteLength;
        length += segment.byteLength;
      }
    }
    this.sql().exec('UPDATE stream_state SET length = ?, last_activity = ? WHERE id = 0', length, Date.now());
    for (const socket of this.ctx.getWebSockets()) socket.send('changed');
    return { kind: 'appended' };
  }

  async end(): Promise<'ended' | 'expired'> {
    if (this.state() === null) return 'expired';
    this.sql().exec('UPDATE stream_state SET ended = 1, last_activity = ? WHERE id = 0', Date.now());
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'ended');
    return 'ended';
  }

  async fetch(request: Request): Promise<Response> {
    const fromOffset = Number(new URL(request.url).searchParams.get('fromOffset') ?? '0');
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
      return new Response('fromOffset must be a non-negative safe integer', { status: 400 });
    }
    if (!await this.exists()) return new Response('LogStream not found', { status: 404 });

    const [client, server] = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (this.state()!.ended === 1) server.close(1000, 'ended');
    return new Response(null, { status: 101, webSocket: client });
  }

  async readChunk(fromOffset: number): Promise<LogStreamReadResult> {
    assertOffset(fromOffset, 'LogStream read offset');
    const state = this.state();
    if (state === null) return { kind: 'expired' };

    this.sql().exec('UPDATE stream_state SET last_activity = ? WHERE id = 0', Date.now());
    if (fromOffset >= state.length) return { kind: 'tail', ended: state.ended === 1 };

    const segment = this.sql().exec<{ start_offset: number; bytes: ArrayBuffer }>(
      'SELECT start_offset, bytes FROM segments WHERE start_offset <= ? ORDER BY start_offset DESC LIMIT 1',
      fromOffset,
    ).one();
    return {
      kind: 'chunk',
      bytes: new Uint8Array(segment.bytes).slice(fromOffset - segment.start_offset).buffer as ArrayBuffer,
    };
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
    // Clearing storage and the alarm together prevents a later open from
    // inheriting the expired actor's alarm.
    await this.ctx.blockConcurrencyWhile(async () => {
      for (const socket of this.ctx.getWebSockets()) socket.close(1012, 'expired');
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    });
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    socket.close(1011, 'interrupted');
    throw error;
  }
}
