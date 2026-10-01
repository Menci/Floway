import type { DumpMetadata, DumpRunWrite } from './types.ts';
import { createRunEncoder, streamFact, toNdjson, type Event, type StreamFact } from '@floway-dev/pipeline';
import { LOG_STREAM_IDLE_MS, type BackgroundScheduler, type LogStream } from '@floway-dev/platform';

export interface StreamRecording {
  readonly fact: StreamFact;
  frame(frame: unknown): void | Promise<void>;
  end(): void | Promise<void>;
}

export interface StreamRecorder {
  openStream(): StreamRecording;
}

export interface RecordingPorts {
  readonly id: string;
  readonly startedAt: number;
  write(record: DumpRunWrite): Promise<void>;
  publish(meta: DumpMetadata): Promise<void>;
  openLive(): Promise<LogStream>;
  background: BackgroundScheduler;
}

const LIVE_APPEND_ATTEMPTS = 3;
const CHUNK_BYTES = 64 * 1024;

export const runStreamId = (scopeId: string, runId: string): string => `${scopeId}/${runId}`;

export const createRunRecorder = (ports: RecordingPorts) => {
  const encode = createRunEncoder();
  const metadata = Promise.withResolvers<DumpMetadata>();
  const bytes = new TransformStream<Uint8Array, Uint8Array>();
  const writer = bytes.writable.getWriter();
  let live: LogStream | null = null;
  let offset = 0;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let heartbeatWrite: Promise<void> = Promise.resolve();
  let closing = false;
  let tail: Promise<void> = Promise.resolve();
  let streams = 0;
  let answerStream: StreamRecording | undefined;

  // One event owns its entire object batch; concurrent deferred outcomes cannot overtake it.
  const sink = (event: Event): Promise<void> => {
    const write = tail.then(async () => {
      const bytes = new TextEncoder().encode(toNdjson(encode(event)));
      await liveReady;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        await writer.write(chunk);
        await appendLive(chunk);
      }
    });
    tail = write;
    return write;
  };

  const flush = (): Promise<void> => tail;

  const appendLive = async (bytes: Uint8Array): Promise<void> => {
    const stream = live;
    if (stream === null) return;
    const atOffset = offset;
    for (let attempt = 0; attempt < LIVE_APPEND_ATTEMPTS; attempt += 1) {
      try {
        await stream.append(atOffset, bytes);
        offset += bytes.byteLength;
        return;
      } catch (error) {
        if (attempt + 1 === LIVE_APPEND_ATTEMPTS) {
          live = null;
          console.error('[dump] live stream unavailable; durable recording continues', error);
        }
      }
    }
  };

  const scheduleHeartbeat = (): void => {
    if (closing || live === null) return;
    heartbeat = setTimeout(() => {
      // The acknowledged offset is safe during an in-flight data append: an empty write
      // adds no bytes, and durable backpressure must not block the temporary stream lease.
      const heartbeat = appendLive(new Uint8Array());
      heartbeatWrite = heartbeat.then(() => { scheduleHeartbeat(); });
    }, LOG_STREAM_IDLE_MS / 2);
  };

  const frame = async (value: unknown): Promise<void> => {
    answerStream ??= openStream();
    await answerStream.frame(value);
  };

  const openStream = (): StreamRecording => {
    const streamId = ++streams;
    return {
      fact: streamFact(streamId),
      frame: frame => sink({ type: 'stream.frame', streamId, frames: [frame] }),
      end: () => sink({ type: 'stream.end', streamId }),
    };
  };

  const abort = async (error: unknown): Promise<never> => {
    closing = true;
    clearTimeout(heartbeat);
    metadata.reject(error);
    try { await writer.abort(error); } catch (cleanupError) {
      if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'Run recording failed and writer abort also failed', { cause: error });
    }
    throw error;
  };

  const finish = async (metadataFactory: () => Promise<DumpMetadata>): Promise<void> => {
    try {
      const meta = await metadataFactory();
      await flush();
      metadata.resolve(meta);
      await writer.close();
      await stored;
      await ports.publish(meta);
      await liveReady;
      closing = true;
      clearTimeout(heartbeat);
      await heartbeatWrite;
      if (live !== null) {
        try { await live.end(); } catch (error) { console.error('[dump] live stream end failed', error); }
      }
    } catch (error) {
      await abort(error);
    } finally {
      closing = true;
      clearTimeout(heartbeat);
    }
  };

  // The metadata wait can reject before the storage reader reaches it; storage owns reporting.
  void metadata.promise.catch(() => {});
  const stored = ports.write({
    id: ports.id, startedAt: ports.startedAt, events: bytes.readable, metadata: metadata.promise,
  }).catch(error => abort(error));
  ports.background(stored);
  const liveReady = ports.openLive().then(stream => {
    live = stream;
    scheduleHeartbeat();
    return stream;
  }).catch(error => {
    console.error('[dump] live stream open failed', error);
    return null;
  });

  return { sink, flush, frame, openStream, finish };
};

export type RunRecorder = ReturnType<typeof createRunRecorder>;
