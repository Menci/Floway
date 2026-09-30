import { DumpAttribution, oneLineError, streamReadError } from './attribution.ts';
import { getDumpBroker, getDumpStore } from './registry.ts';
import type { StreamRecording } from './turn-dump.ts';
import type { DumpMetadata } from './types.ts';
import { attemptTtftMs, type AttemptTiming } from '../data-plane/shared/attempt-timing.ts';
import type { RequestBody } from '../data-plane/shared/request-body.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import { createRunEncoder, streamFact, toNdjson, type Event } from '@floway-dev/pipeline';
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
    this.backgroundScheduler((async () => {
      await getDumpStore().putRun(apiKey.id, {
        id, startedAt, events: bytes.readable, metadata: this.metadata.promise,
      });
      await getDumpBroker().publish(apiKey.id, await this.metadata.promise);
    })().catch(async error => {
      this.metadata.reject(error);
      await this.writer.abort(error);
      throw error;
    }));
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
      await this.liveReady;
      this.closing = true;
      clearTimeout(this.heartbeat);
      await this.heartbeatWrite;
      if (this.live !== null) {
        try { await this.live.end(); } catch (error) { console.error('[dump] live stream end failed', error); }
      }
    } catch (error) {
      this.metadata.reject(error);
      throw error;
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
