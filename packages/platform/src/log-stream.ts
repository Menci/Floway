// The transient carrier for one dump while it is being produced. One writer appends bytes;
// any number of readers attach at any moment and read from wherever they ask, following the
// tail as it grows. When the run finishes the stream is redundant — the durable artifact is
// already stored — and it expires.
//
// Deliberately not a durable store. Durability is the writer's job and happens on a separate
// path, so losing a stream costs the live view of one run and nothing else.
//
// The name is CloudWatch Logs': a log stream is a sequence of events sharing one source,
// creatable, readable from the head, followable live, and expiring on a retention policy.

/**
 * A stream of opaque bytes.
 *
 * It carries bytes rather than records on purpose. The dump layer serializes an entry to an
 * NDJSON line and appends `line + "\n"`; this never parses one and does not know what NDJSON
 * is. Keeping records out is what leaves an implementation free to split and merge at any
 * byte position, and it makes a stream's bytes identical to the durable artifact's, so the
 * two paths can be checked against each other.
 */
export interface LogStream {
  /**
   * Appends `bytes` so that they occupy the stream from `atOffset`.
   *
   * The offset is not decoration. An append that failed cannot be told apart from one that
   * landed and lost its acknowledgement, so the writer retries; without a position a retry
   * would splice duplicate bytes into the middle of a line.
   *
   * A store resolves the write by position alone: it writes only the part of `bytes` beyond
   * the current length, and **assumes the overlapping range is identical** rather than
   * comparing it. There is one writer and it retries the same bytes at the same offset, so a
   * mismatch is reachable only through a bug in that writer — and reading back to compare on
   * every retry would spend real work defending a position that cannot be defended.
   *
   * An `atOffset` *above* the current length leaves a hole, which is not representable, and
   * every implementation rejects it loudly.
   *
   * Working in positions rather than call identity also lets the writer re-chunk between
   * attempts: a failed append may be retried inside a larger one that subsumes it.
   */
  append(atOffset: number, bytes: Uint8Array): Promise<void>;

  /** Seals the append side. A `read()` in progress drains what remains and completes
   *  normally, and a reader attaching afterwards still gets everything for as long as the
   *  stream exists. */
  end(): Promise<void>;

  /**
   * Reads from `fromOffset` to the end of the stream, following the tail until `end()`.
   *
   * Completing normally means the stream ended. Throwing means the read was interrupted.
   * Nothing else distinguishes the two, which is why the HTTP binding frames.
   *
   * `fromOffset` makes an interrupted reader cheap: deployments terminate every reader
   * unconditionally, so a reader records the offset just past the last complete line it
   * processed and resumes there. The offset lives in the caller, so there is no server-side
   * cursor and no seam between backlog and live tail. Zero is the ordinary case.
   *
   * Chunk boundaries are arbitrary. Yields are `Uint8Array` and never `string`, because a
   * split can land in the middle of a UTF-8 sequence and a consumer handed half a code point
   * cannot repair it — decode with `TextDecoder` and `{ stream: true }`, and split lines
   * yourself. Assuming one chunk is one line is the bug this shape invites.
   */
  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Opens streams by id. A stream is created for one run and expires after it, so there is no
 *  delete: reclamation is the implementation's own idle rule. */
export interface LogStreamStore {
  open(streamId: string): LogStream;
}

let logStreamStore: LogStreamStore | null = null;

export const initLogStreamStore = (store: LogStreamStore): void => {
  logStreamStore = store;
};

export const getLogStreamStore = (): LogStreamStore => {
  if (!logStreamStore) throw new Error('LogStreamStore not initialized - call initLogStreamStore() first');
  return logStreamStore;
};

/** Thrown when an append would leave a hole. Named so a caller can tell a writer defect from
 *  a transport failure: the transport failure is worth retrying and this is not. */
export class LogStreamHoleError extends Error {
  constructor(readonly atOffset: number, readonly length: number) {
    super(`LogStream append at ${atOffset} would leave a hole: the stream is ${length} bytes long`);
    this.name = 'LogStreamHoleError';
  }
}
