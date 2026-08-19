import { DurableObject } from 'cloudflare:workers';

// One SQLite-backed Durable Object per LogStream, addressed by stream id, holding the bytes
// for that stream and nothing else. It is created for one run and expires after it. Its
// schema is created here on first write, never enters `migrations_dir`, and is never a Time
// Travel recovery target — the recovery target is the durable artifact.
//
// `extends DurableObject` is load-bearing: the runtime gates RPC dispatch on the actor
// extending this base class, and without it a direct method call is rejected with "the
// receiving Durable Object does not support RPC".

/** Rows are byte segments keyed by their starting offset. Because a stream carries opaque
 *  bytes, the object chops at whatever size suits it with no regard for where entries begin
 *  or end — which is what removes two problems an entry-shaped design would have had.
 *  Slicing a large entry is not a special case, so nothing has to know that production
 *  request bodies average 881 KB and routinely hold a single ~500 KB string against a row
 *  limit measured between 2.1 MB and 3 MB. And merging small entries is not an optimisation
 *  to schedule, because writes are always segment-sized: measured throughput is ~17–18k
 *  rows/s at 200 B against ~2.2–2.5k at 20 KB, which is 3.5 MB/s against 44 MB/s. */
const SEGMENT_BYTES = 64 * 1024;

/** Ended and idle for this long is the whole of expiry. There is no reference counting:
 *  reader liveness is not reliably observable — a peer that vanishes without a TCP FIN is
 *  invisible for at least 150 s — so a count built on it would be an unreliable optimisation
 *  guarded by a reliable timeout, and the timeout is simply the whole mechanism. It also
 *  covers the one window where a reader arrives after the stream vanished but before the
 *  durable artifact is complete, as long as it outlasts that flush. */
const IDLE_RECLAIM_MS = 60_000;

interface ReaderState {
  offset: number;
}

export class LogStreamDO extends DurableObject {
  // Declared explicitly so the type-check sees `(ctx, env)` even where the
  // `cloudflare:workers` types resolve to a parameterless base.
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // `getWebSockets()` is already populated inside the constructor after a hibernation
    // wake, and per-reader state is rebuilt from `serializeAttachment` where it is needed
    // rather than held in memory here.
  }

  private sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private ensureSchema(): void {
    this.sql().exec(`
      CREATE TABLE IF NOT EXISTS segments (start_offset INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS stream_state (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        length INTEGER NOT NULL,
        ended INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO stream_state (id, length, ended, last_activity) VALUES (0, 0, 0, 0);
    `);
  }

  private state(): { length: number; ended: boolean } {
    this.ensureSchema();
    const row = [...this.sql().exec<{ length: number; ended: number }>('SELECT length, ended FROM stream_state WHERE id = 0')][0];
    return { length: row?.length ?? 0, ended: (row?.ended ?? 0) === 1 };
  }

  /**
   * Appends so that `bytes` occupy the stream from `atOffset`.
   *
   * Resolving this against the position rule needs no locking: `ctx.storage.sql` is
   * synchronous, so reading the length, slicing off what is already stored and writing the
   * remainder all happen inside one JavaScript turn, and the object is single-threaded.
   *
   * The overlapping range is assumed identical and never compared — one writer retries the
   * same bytes at the same offset, so a mismatch is reachable only through a bug in it.
   */
  async append(atOffset: number, bytes: ArrayBuffer): Promise<void> {
    const { length } = this.state();
    if (atOffset > length) {
      throw new Error(`LogStream append at ${atOffset} would leave a hole: the stream is ${length} bytes long`);
    }
    const incoming = new Uint8Array(bytes);
    const fresh = incoming.subarray(length - atOffset);
    const now = Date.now();
    if (fresh.byteLength === 0) {
      this.sql().exec('UPDATE stream_state SET last_activity = ? WHERE id = 0', now);
      return;
    }

    let written = length;
    for (let cursor = 0; cursor < fresh.byteLength; cursor += SEGMENT_BYTES) {
      const segment = fresh.subarray(cursor, cursor + SEGMENT_BYTES);
      this.sql().exec('INSERT INTO segments (start_offset, bytes) VALUES (?, ?)', written, segment);
      written += segment.byteLength;
    }
    this.sql().exec('UPDATE stream_state SET length = ?, last_activity = ? WHERE id = 0', written, now);

    for (const ws of this.ctx.getWebSockets()) this.pump(ws);
  }

  /** Seals the append side. Readers drain what remains and close cleanly, which is what tells
   *  the Worker to emit its terminating frame. */
  async end(): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    this.sql().exec('UPDATE stream_state SET ended = 1, last_activity = ? WHERE id = 0', now);
    for (const ws of this.ctx.getWebSockets()) {
      this.pump(ws);
      ws.close(1000, 'ended');
    }
    await this.armAlarm();
  }

  /** A reader attaches here. The object must be the WebSocket server: hibernation is
   *  unavailable for outgoing sockets, so the direction may never be inverted. */
  async fetch(request: Request): Promise<Response> {
    const fromOffset = Number(new URL(request.url).searchParams.get('fromOffset') ?? '0');
    if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
      return new Response('fromOffset must be a non-negative safe integer', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // Survives hibernation, 16 KiB cap — an offset is nothing.
    server.serializeAttachment({ offset: fromOffset } satisfies ReaderState);

    this.pump(server);
    if (this.state().ended) server.close(1000, 'ended');
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Sends everything this reader has not seen, and records how far it got.
   *
   * Nothing throttles it. Measured: 1 GiB pushed to a socket whose reader had stopped
   * draining left the object untouched, and the memory ceiling was identical with and
   * without 200 MiB queued — the outgoing queue is not charged against the object. That
   * accounting is undocumented; if it changes, the consequence is an isolate reset, which
   * surfaces loudly and drops the writer onto the degradation path that has to exist anyway.
   */
  private pump(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as ReaderState | null;
    if (attachment === null) return;
    const { length } = this.state();
    let offset = attachment.offset;

    // The segment holding an offset is the last one whose start is not greater than it.
    while (offset < length) {
      const row = [...this.sql().exec<{ start_offset: number; bytes: ArrayBuffer }>(
        'SELECT start_offset, bytes FROM segments WHERE start_offset <= ? ORDER BY start_offset DESC LIMIT 1',
        offset,
      )][0];
      if (row === undefined) break;
      const segment = new Uint8Array(row.bytes);
      const within = offset - row.start_offset;
      if (within >= segment.byteLength) break;
      const slice = segment.subarray(within);
      ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
      offset += slice.byteLength;
    }

    ws.serializeAttachment({ offset } satisfies ReaderState);
  }

  /** Coarse rather than per-append: each `setAlarm()` is a billed row write, so the alarm is
   *  re-armed against `last_activity` and simply re-arms itself when it fires early. */
  private async armAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + IDLE_RECLAIM_MS);
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const row = [...this.sql().exec<{ ended: number; last_activity: number }>('SELECT ended, last_activity FROM stream_state WHERE id = 0')][0];
    const ended = (row?.ended ?? 0) === 1;
    const idleFor = Date.now() - (row?.last_activity ?? 0);
    if (!ended || idleFor < IDLE_RECLAIM_MS) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_RECLAIM_MS);
      return;
    }

    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'expired');
    // `deleteAlarm()` is not redundant. On a compatibility date before 2026-02-24
    // `deleteAll()` leaves a pending alarm in place — verified that it survived, fired, and
    // re-created storage, resurrecting an object that was supposed to have ceased to exist.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  // Hibernation hooks. `webSocketClose` must complete the handshake from the actor side —
  // without it the client sees a 1006 and the actor holds the dead socket until the
  // hibernation timeout.
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }
  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}
}
