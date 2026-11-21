export class StreamOwnershipError extends Error {
  readonly streamId: number;

  constructor(streamId: number, operation: string) {
    super(`Stream #${streamId} handle ownership was already transferred; cannot call ${operation}`);
    this.name = 'StreamOwnershipError';
    this.streamId = streamId;
  }
}

export class DuplicateStreamCloseError extends Error {
  readonly streamId: number;

  constructor(streamId: number, state: string) {
    super(`Stream #${streamId} cannot be closed explicitly while already ${state}`);
    this.name = 'DuplicateStreamCloseError';
    this.streamId = streamId;
  }
}

export class ConcurrentStreamReadError extends Error {
  readonly streamId: number;

  constructor(streamId: number) {
    super(`Stream #${streamId} does not permit concurrent iterator.next() reads`);
    this.name = 'ConcurrentStreamReadError';
    this.streamId = streamId;
  }
}

export class StreamLeakError extends Error {
  readonly stageName: string;
  readonly leakedStreamIds: readonly number[];

  constructor(stageName: string, leakedStreamIds: readonly number[]) {
    super(`Stage "${stageName}" exited without closing or exporting stream(s): ${leakedStreamIds.map(id => `#${id}`).join(', ')}`);
    this.name = 'StreamLeakError';
    this.stageName = stageName;
    this.leakedStreamIds = leakedStreamIds;
  }
}

export class StageScopeClosedError extends Error {
  readonly stageName: string;

  constructor(stageName: string, operation: string) {
    super(`Stage "${stageName}" scope is already closed; cannot call ${operation}`);
    this.name = 'StageScopeClosedError';
    this.stageName = stageName;
  }
}

export class InvalidFactValueError extends TypeError {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Invalid pipeline data at ${path}: ${detail}`);
    this.name = 'InvalidFactValueError';
    this.path = path;
  }
}

export class SecretLeakError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Raw secret plaintext leaked into unredacted dump value at ${path}`);
    this.name = 'SecretLeakError';
    this.path = path;
  }
}
