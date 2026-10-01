import { DumpAttribution, oneLineError, streamReadError } from './attribution.ts';
import { getDumpBroker, getDumpStore } from './registry.ts';
import type { DumpMetadata } from './types.ts';
import { attemptTtftMs, type AttemptTiming } from '../data-plane/shared/attempt-timing.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createRunEncoder, isStreamFact, streamFact, toNdjson, type Event, type StreamFact } from '@floway-dev/pipeline';
import { getLogStreamStore, LOG_STREAM_IDLE_MS, type BackgroundScheduler, type LogStream } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

interface RequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly bodyByteLength: number;
  readonly streamError: string | null;
}

const LIVE_APPEND_ATTEMPTS = 3;
const CHUNK_BYTES = 64 * 1024;

export const runStreamId = (keyId: string, runId: string): string => `${keyId}/${runId}`;

export class RunDump {
  readonly id: string;
  private readonly attribution = new DumpAttribution();
  private readonly encode = createRunEncoder();
  private readonly metadata = Promise.withResolvers<DumpMetadata>();
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly stored: Promise<void>;
  private readonly liveReady: Promise<LogStream | null>;
  private live: LogStream | null = null;
  private offset = 0;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private heartbeatWrite: Promise<void> = Promise.resolve();
  private closing = false;
  private tail: Promise<void> = Promise.resolve();
  private runDrain: (() => Promise<void>) | null = null;
  private sentPayloadBytes = 0;
  private streams = 0;
  private answerStream: StreamRecording | undefined;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
    private readonly wantsStream: boolean,
    private readonly timing: AttemptTiming,
  ) {
    const id = ulid(startedAt);
    this.id = id;
    const bytes = new TransformStream<Uint8Array, Uint8Array>();
    this.writer = bytes.writable.getWriter();
    // The metadata wait can reject before the storage reader reaches it; storage owns reporting.
    void this.metadata.promise.catch(() => {});
    const stored = getDumpStore().putRun(apiKey.id, {
      id, startedAt, events: bytes.readable, metadata: this.metadata.promise,
    }).catch(error => this.abort(error));
    this.stored = stored;
    this.backgroundScheduler((async () => {
      await stored;
      await getDumpBroker().publish(apiKey.id, await this.metadata.promise);
    })());
    this.liveReady = getLogStreamStore().open(runStreamId(apiKey.id, id)).then(stream => {
      this.live = stream;
      this.scheduleHeartbeat();
      return stream;
    }).catch(error => {
      console.error('[dump] live stream open failed', error);
      return null;
    });
  }

  afterRun(drain: () => Promise<void>): void {
    this.runDrain = drain;
  }

  // One event owns its entire object batch; concurrent deferred outcomes cannot overtake it.
  readonly sink = (event: Event): Promise<void> => {
    const write = this.tail.then(async () => {
      const bytes = new TextEncoder().encode(toNdjson(this.encode(event)));
      await this.liveReady;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        await this.writer.write(chunk);
        await this.appendLive(chunk);
      }
    });
    this.tail = write;
    return write;
  };

  private async appendLive(bytes: Uint8Array): Promise<void> {
    const stream = this.live;
    if (stream === null) return;
    const atOffset = this.offset;
    for (let attempt = 0; attempt < LIVE_APPEND_ATTEMPTS; attempt += 1) {
      try {
        await stream.append(atOffset, bytes);
        this.offset += bytes.byteLength;
        return;
      } catch (error) {
        if (attempt + 1 === LIVE_APPEND_ATTEMPTS) {
          this.live = null;
          console.error('[dump] live stream unavailable; durable recording continues', error);
        }
      }
    }
  }

  private scheduleHeartbeat(): void {
    if (this.closing || this.live === null) return;
    this.heartbeat = setTimeout(() => {
      const heartbeat = this.tail.then(() => this.appendLive(new Uint8Array()));
      this.tail = heartbeat;
      this.heartbeatWrite = heartbeat.then(() => { this.scheduleHeartbeat(); });
    }, LOG_STREAM_IDLE_MS / 2);
  }

  requestedModel(model: string): void { this.attribution.requestedModel(model); }
  error(kind: 'upstream' | 'gateway', upstream?: string): void { this.attribution.error(kind, upstream); }
  failed(reason: unknown, options?: { readonly fallback: boolean }): void { this.attribution.failed(reason, options); }
  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void { this.attribution.success(identity, usage); }

  async frame(frame: ProtocolFrame<unknown>): Promise<void> {
    this.answerStream ??= this.openStream();
    await this.answerStream.frame(frame);
  }

  openStream(): StreamRecording {
    const streamId = ++this.streams;
    return {
      frame: frame => this.sink({ type: 'stream.frame', streamId, frames: [frame] }),
      end: () => this.sink({ type: 'stream.end', streamId }),
      fact: streamFact(streamId),
    };
  }

  openSubRequest(turn: { readonly method: string; readonly path: string }, wantsStream: boolean, timing: AttemptTiming): RunDump {
    return new RunDump(
      this.apiKey,
      { method: turn.method, path: turn.path, bodyByteLength: 0, streamError: null },
      Date.now(),
      this.backgroundScheduler,
      wantsStream,
      timing,
    );
  }

  recordSentPayloadBytes(byteLength: number): void { this.sentPayloadBytes += byteLength; }

  finalize(status: number | null, responseBytes: number): void;
  finalize(response: Response): Response;
  finalize(...args: [number | null, number] | [Response]): void | Response {
    if (args.length === 2) {
      this.backgroundScheduler(this.write(args[0], args[1] + this.sentPayloadBytes, null));
      return;
    }
    const [response] = args;
    if (response.body === null) { this.finalize(response.status, 0); return response; }
    const [forClient, forMeasure] = response.body.tee();
    this.backgroundScheduler((async () => {
      const reader = forMeasure.getReader();
      let payloadBytes = 0;
      let streamError: string | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          payloadBytes += value.byteLength;
        }
      } catch (error) {
        streamError = oneLineError(error);
      } finally {
        reader.releaseLock();
      }
      await this.write(response.status, payloadBytes, streamError);
    })());
    return new Response(forClient, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private async abort(error: unknown): Promise<never> {
    this.closing = true;
    clearTimeout(this.heartbeat);
    this.metadata.reject(error);
    try { await this.writer.abort(error); } catch (cleanupError) {
      if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'Run recording failed and writer abort also failed', { cause: error });
    }
    throw error;
  }

  private async write(status: number | null, responseBytes: number, responseStreamError: string | null): Promise<void> {
    try {
      if (this.runDrain !== null) {
        try { await this.runDrain(); } catch (error) { this.failed(error); }
      }
      await this.tail;
      const completedAt = Date.now();
      const meta = await this.attribution.metadata({
        id: this.id, startedAt: this.startedAt, completedAt,
        method: this.requestSnapshot.method, path: this.requestSnapshot.path, status,
        requestBytes: this.requestSnapshot.bodyByteLength, responseBytes,
        ttftMs: this.wantsStream ? attemptTtftMs(this.timing) : null,
        fallbackError: streamReadError(this.requestSnapshot.streamError, responseStreamError),
      });
      this.metadata.resolve(meta);
      await this.writer.close();
      await this.stored;
      await this.liveReady;
      this.closing = true;
      clearTimeout(this.heartbeat);
      await this.heartbeatWrite;
      if (this.live !== null) {
        try { await this.live.end(); } catch (error) { console.error('[dump] live stream end failed', error); }
      }
    } catch (error) {
      await this.abort(error);
    } finally {
      this.closing = true;
      clearTimeout(this.heartbeat);
    }
  }
}

export const openRunDump = (
  apiKey: ApiKey,
  turn: { readonly method: string; readonly path: string; readonly body: RequestBody },
  backgroundScheduler: BackgroundScheduler,
  wantsStream: boolean,
  timing: AttemptTiming,
): RunDump | null => apiKey.dumpRetentionSeconds === null ? null : new RunDump(
  apiKey,
  { method: turn.method, path: turn.path, bodyByteLength: turn.body.bytes.byteLength, streamError: turn.body.streamError },
  Date.now(), backgroundScheduler, wantsStream, timing,
);

export interface StreamRecording {
  frame(frame: ProtocolFrame<unknown>): Promise<void>;
  end(): Promise<void>;
  readonly fact: StreamFact;
}

/**
 * Records a stream's frames as they are read, and hands them on untouched.
 *
 * What the record holds is the stream as the client is served it, so the tee goes outside
 * whatever shapes the frames and inside whatever frames them for a transport. For a family with
 * translated wires that is its edge and nowhere lower: below the edge the frames are the
 * upstream's and may still be another protocol's, above it they are transport frames the record
 * does not describe. A non-streaming turn folds the same frames into one value, and recording
 * here is what puts both in the record — the frames as they flowed beside the value assembled
 * from them.
 *
 * Reading is what records: a losing attempt nobody read contributes nothing, because the
 * release path drains the stream underneath this rather than through it, and a stream that
 * stopped short is recorded as far as it got.
 *
 * The value handed back *is* the stream reference, so the fact that holds it encodes as
 * `{"$stream": n}` and the frames that arrive afterwards say which stream they belong to.
 *
 * A record holds protocol frames, which is what most families' streams already carry. The
 * family whose stream is bare protocol events says how one becomes a frame, because the record
 * cannot guess and a cast would be it guessing.
 */
export function recordStream<T extends ProtocolFrame<unknown>>(stream: AsyncIterable<T>, dump: RunDump | null): AsyncIterable<T>;
export function recordStream<T>(stream: AsyncIterable<T>, dump: RunDump | null, asFrame: (value: T) => ProtocolFrame<unknown> | null): AsyncIterable<T>;
export function recordStream<T>(
  stream: AsyncIterable<T>,
  dump: RunDump | null,
  asFrame: (value: T) => ProtocolFrame<unknown> | null = value => value as ProtocolFrame<unknown>,
): AsyncIterable<T> {
  // No recording configured hands the same iterable back, so a record shows no step where
  // nothing happened and the stream is not wrapped for nobody.
  if (dump === null) return stream;

  const recording = dump.openStream();
  return {
    ...recording.fact,
    [Symbol.asyncIterator]: () => (async function* () {
      for await (const value of stream) {
        const frame = asFrame(value);
        if (frame !== null) await recording.frame(frame);
        yield value;
      }
      // Reached only where the source ran out on its own, which is what makes the record of
      // this stream complete. A reader that stopped early never gets here.
      await recording.end();
    })(),
  };
}

/**
 * The reference a value carries to the stream the record holds, for a wrapper to carry across.
 *
 * A stream is framed again on its way out — protocol frames become SSE — and what the client
 * is handed is a different object over the same frames. Carrying the reference onto it is what
 * lets the fact that produced the stream and the fact that framed it point at one record.
 */
export const streamReferenceOf = (value: unknown): StreamFact | Record<string, never> =>
  isStreamFact(value) ? { ...value } : {};
