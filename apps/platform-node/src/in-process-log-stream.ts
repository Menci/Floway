import {
  LOG_STREAM_IDLE_MS,
  LogStreamEndedError,
  LogStreamExpiredError,
  LogStreamHoleError,
  type LogStream,
  type LogStreamStore,
} from '@floway-dev/platform';

const SEGMENT_BYTES = 64 * 1024;

interface Segment {
  offset: number;
  bytes: Uint8Array;
}

const assertOffset = (offset: number, name: string): void => {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
};

class InProcessLogStream implements LogStream {
  private readonly segments: Segment[] = [];
  private readonly waiters = new Set<() => void>();
  private length = 0;
  private ended = false;
  private expired = false;
  private lastActivity = Date.now();

  get idleSince(): number {
    return this.lastActivity;
  }

  expire(): void {
    if (this.expired) return;
    this.expired = true;
    this.wake();
  }

  private requireLive(): void {
    if (this.expired) throw new LogStreamExpiredError();
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async append(atOffset: number, bytes: Uint8Array): Promise<void> {
    this.requireLive();
    assertOffset(atOffset, 'LogStream append offset');
    if (atOffset > this.length) throw new LogStreamHoleError(atOffset, this.length);

    const fresh = bytes.subarray(this.length - atOffset);
    if (this.ended && fresh.byteLength > 0) throw new LogStreamEndedError();
    this.touch();

    let cursor = 0;
    while (cursor < fresh.byteLength) {
      const last = this.segments.at(-1);
      if (last !== undefined && last.bytes.byteLength < SEGMENT_BYTES) {
        const take = Math.min(SEGMENT_BYTES - last.bytes.byteLength, fresh.byteLength - cursor);
        const extended = new Uint8Array(last.bytes.byteLength + take);
        extended.set(last.bytes);
        extended.set(fresh.subarray(cursor, cursor + take), last.bytes.byteLength);
        last.bytes = extended;
        cursor += take;
        this.length += take;
      } else {
        const segment = fresh.slice(cursor, cursor + SEGMENT_BYTES);
        this.segments.push({ offset: this.length, bytes: segment });
        cursor += segment.byteLength;
        this.length += segment.byteLength;
      }
    }
    this.wake();
  }

  async end(): Promise<void> {
    this.requireLive();
    if (this.ended) return;
    this.ended = true;
    this.touch();
    this.wake();
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    assertOffset(fromOffset, 'LogStream read offset');
    const stream = this;

    return {
      async *[Symbol.asyncIterator]() {
        let offset = fromOffset;
        for (;;) {
          stream.requireLive();
          signal.throwIfAborted();
          stream.touch();

          if (offset < stream.length) {
            const segment = stream.segmentAt(offset);
            const bytes = segment.bytes.slice(offset - segment.offset);
            offset += bytes.byteLength;
            yield bytes;
            continue;
          }
          if (stream.ended) return;

          await new Promise<void>(resolve => {
            const wake = (): void => {
              stream.waiters.delete(wake);
              signal.removeEventListener('abort', wake);
              resolve();
            };
            stream.waiters.add(wake);
            signal.addEventListener('abort', wake, { once: true });
            if (signal.aborted) wake();
          });
        }
      },
    };
  }

  private segmentAt(offset: number): Segment {
    let low = 0;
    let high = this.segments.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.segments[middle]!.offset <= offset) low = middle;
      else high = middle;
    }
    return this.segments[low]!;
  }
}

export class InProcessLogStreamStore implements LogStreamStore {
  private readonly streams = new Map<string, InProcessLogStream>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  async open(streamId: string): Promise<LogStream> {
    const existing = this.lookup(streamId);
    if (existing !== null) return existing;

    const stream = new InProcessLogStream();
    this.streams.set(streamId, stream);
    this.startSweeping();
    return stream;
  }

  async get(streamId: string): Promise<LogStream | null> {
    return this.lookup(streamId);
  }

  private lookup(streamId: string): InProcessLogStream | null {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return null;
    if (Date.now() - stream.idleSince < LOG_STREAM_IDLE_MS) return stream;

    stream.expire();
    this.streams.delete(streamId);
    return null;
  }

  private startSweeping(): void {
    if (this.sweeper !== null) return;

    this.sweeper = setInterval(() => {
      for (const [streamId, stream] of this.streams) {
        if (Date.now() - stream.idleSince < LOG_STREAM_IDLE_MS) continue;
        stream.expire();
        this.streams.delete(streamId);
      }
      if (this.streams.size === 0) {
        clearInterval(this.sweeper!);
        this.sweeper = null;
      }
    }, LOG_STREAM_IDLE_MS);
    this.sweeper.unref?.();
  }
}
