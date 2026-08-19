import { LogStreamHoleError, type LogStream, type LogStreamStore } from '@floway-dev/platform';

// The Node target's LogStream.
//
// `28-log-stream.md` §6 specifies Redis Streams. This does not use them, and the reason is
// worth stating rather than discovering: this target has no other cross-instance component.
// Its channel broker is an in-process `EventTarget`, its file store is the filesystem and its
// database is local SQLite, so a Redis-backed stream would be the only piece able to serve a
// read from a second instance — and a deployment that needs a Redis to show a live dump, but
// still cannot fan a dump notification across instances, is not a coherent middle state.
// Whether this target becomes multi-instance is a design decision, not one to settle by
// adding a dependency here; the interface exists so that swapping this for the Redis
// implementation is additive when it is settled.
//
// The semantics are the contract's, not a simplification of it: the position rule, the hole
// rejection, seeking by offset, following the tail, and reclamation once ended and idle.

/** Ended and idle for this long and the stream is dropped. It only has to outlast the writer's
 *  flush of the durable artifact, which is what closes the window where a reader arrives after
 *  the stream is gone but before the artifact is complete. */
const IDLE_RECLAIM_MS = 60_000;

interface Waiter {
  resolve: () => void;
}

class InProcessLogStream implements LogStream {
  // Segments are not modelled: with one process there is nothing to chop for, and a growing
  // buffer keeps the offset arithmetic the contract is stated in exactly as it reads.
  private bytes = new Uint8Array(0);
  private ended = false;
  private lastActivity = Date.now();
  private readonly waiters = new Set<Waiter>();

  get idleSince(): number {
    return this.lastActivity;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  append(atOffset: number, incoming: Uint8Array): Promise<void> {
    if (atOffset > this.bytes.byteLength) {
      // A hole is not representable. This is a writer defect rather than a transport failure,
      // and the two are worth telling apart: only one of them is worth retrying.
      throw new LogStreamHoleError(atOffset, this.bytes.byteLength);
    }
    this.lastActivity = Date.now();

    // Resolved by position alone: only the part beyond the current length is written, and the
    // overlap is assumed identical rather than compared. One writer retries the same bytes at
    // the same offset, so a mismatch is reachable only through a bug in it.
    const fresh = incoming.subarray(this.bytes.byteLength - atOffset);
    if (fresh.byteLength > 0) {
      const next = new Uint8Array(this.bytes.byteLength + fresh.byteLength);
      next.set(this.bytes);
      next.set(fresh, this.bytes.byteLength);
      this.bytes = next;
      this.wake();
    }
    return Promise.resolve();
  }

  end(): Promise<void> {
    this.ended = true;
    this.lastActivity = Date.now();
    this.wake();
    return Promise.resolve();
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const stream = this;
    return {
      async *[Symbol.asyncIterator]() {
        let offset = fromOffset;
        while (true) {
          if (signal.aborted) throw new Error('LogStream read was interrupted');
          if (offset < stream.bytes.byteLength) {
            const chunk = stream.bytes.slice(offset);
            offset += chunk.byteLength;
            yield chunk;
            continue;
          }
          // Caught up. Ending here is the stream ending; anything else waits for the tail.
          if (stream.ended) return;
          await new Promise<void>(resolve => {
            const waiter: Waiter = { resolve };
            stream.waiters.add(waiter);
            signal.addEventListener('abort', () => {
              stream.waiters.delete(waiter);
              resolve();
            }, { once: true });
          });
        }
      },
    };
  }
}

export class InProcessLogStreamStore implements LogStreamStore {
  private readonly streams = new Map<string, InProcessLogStream>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  open(streamId: string): LogStream {
    const existing = this.streams.get(streamId);
    if (existing !== undefined) return existing;
    const created = new InProcessLogStream();
    this.streams.set(streamId, created);
    this.startSweeping();
    return created;
  }

  /** Ended and idle is the whole of expiry, the same single rule the other implementation
   *  reclaims on. No reference counting: reader liveness is not reliably observable, so a
   *  count would be an unreliable optimisation guarded by a reliable timeout. */
  private startSweeping(): void {
    if (this.sweeper !== null) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, stream] of this.streams) {
        if (stream.isEnded && now - stream.idleSince >= IDLE_RECLAIM_MS) this.streams.delete(id);
      }
      if (this.streams.size === 0 && this.sweeper !== null) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, IDLE_RECLAIM_MS);
    this.sweeper.unref?.();
  }
}
