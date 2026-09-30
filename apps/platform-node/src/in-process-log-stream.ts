import { LOG_STREAM_IDLE_MS, LogStreamEndedError, LogStreamExpiredError, LogStreamHoleError, type LogStream, type LogStreamStore } from '@floway-dev/platform';

// Node's database, files and channel broker share one process boundary, so its
// transient run streams use that same boundary.
const SEGMENT_BYTES = 64 * 1024;

class InProcessLogStream implements LogStream {
  private readonly segments: { offset: number; bytes: Uint8Array }[] = [];
  private length = 0;
  private ended = false;
  private expired = false;
  private lastActivity = Date.now();
  private readonly waiters = new Set<() => void>();

  get idleSince(): number { return this.lastActivity; }

  touch(): void { this.lastActivity = Date.now(); }

  expire(): void {
    this.expired = true;
    this.wake();
  }

  private requireLive(): void {
    if (this.expired) throw new LogStreamExpiredError();
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async append(atOffset: number, bytes: Uint8Array): Promise<void> {
    this.requireLive();
    if (atOffset > this.length) throw new LogStreamHoleError(atOffset, this.length);
    const fresh = bytes.subarray(this.length - atOffset);
    if (this.ended && fresh.byteLength > 0) throw new LogStreamEndedError();
    this.touch();
    for (let cursor = 0; cursor < fresh.byteLength; cursor += SEGMENT_BYTES) {
      const segment = fresh.slice(cursor, cursor + SEGMENT_BYTES);
      this.segments.push({ offset: this.length, bytes: segment });
      this.length += segment.byteLength;
    }
    this.wake();
  }

  async end(): Promise<void> {
    this.requireLive();
    this.ended = true;
    this.touch();
    this.wake();
  }

  private segmentAt(offset: number): { offset: number; bytes: Uint8Array } {
    let low = 0;
    let high = this.segments.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.segments[middle].offset <= offset) low = middle;
      else high = middle;
    }
    return this.segments[low];
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
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
            const wake = () => {
              stream.waiters.delete(wake);
              signal.removeEventListener('abort', wake);
              resolve();
            };
            stream.waiters.add(wake);
            signal.addEventListener('abort', wake, { once: true });
          });
        }
      },
    };
  }
}

export class InProcessLogStreamStore implements LogStreamStore {
  private readonly streams = new Map<string, InProcessLogStream>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  async open(streamId: string): Promise<LogStream> {
    const existing = this.lookup(streamId);
    if (existing !== null) return existing;
    const created = new InProcessLogStream();
    this.streams.set(streamId, created);
    this.startSweeping();
    return created;
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
      for (const [id, stream] of this.streams) {
        if (Date.now() - stream.idleSince < LOG_STREAM_IDLE_MS) continue;
        stream.expire();
        this.streams.delete(id);
      }
      if (this.streams.size === 0 && this.sweeper !== null) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, LOG_STREAM_IDLE_MS);
    this.sweeper.unref?.();
  }
}
