/**
 * A transient byte stream for one live execution. Writers append at explicit
 * positions so retries are idempotent, while readers may attach at any time and
 * follow the tail until the writer seals the stream.
 */
export interface LogStream {
  append(atOffset: number, bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface LogStreamStore {
  open(streamId: string): Promise<LogStream>;
  get(streamId: string): Promise<LogStream | null>;
}

export const LOG_STREAM_IDLE_MS = 60_000;

let logStreamStore: LogStreamStore | null = null;

export const initLogStreamStore = (store: LogStreamStore): void => {
  logStreamStore = store;
};

export const getLogStreamStore = (): LogStreamStore => {
  if (logStreamStore === null) throw new Error('LogStreamStore not initialized - call initLogStreamStore() first');
  return logStreamStore;
};

export class LogStreamHoleError extends Error {
  constructor(readonly atOffset: number, readonly length: number) {
    super(`LogStream append at ${atOffset} would leave a hole: the stream is ${length} bytes long`);
    this.name = 'LogStreamHoleError';
  }
}

export class LogStreamExpiredError extends Error {
  constructor() {
    super('LogStream expired');
    this.name = 'LogStreamExpiredError';
  }
}

export class LogStreamEndedError extends Error {
  constructor() {
    super('LogStream append side is already ended');
    this.name = 'LogStreamEndedError';
  }
}
