export class InvalidFactValueError extends TypeError {
  constructor(readonly path: string, detail: string) {
    super(`Invalid pipeline data at ${path}: ${detail}`);
    this.name = 'InvalidFactValueError';
  }
}

export type DeclarationDirection = 'entry' | 'down' | 'up';

export class DeclarationViolationError extends Error {
  constructor(readonly stage: string, readonly direction: DeclarationDirection, readonly detail: string) {
    super(`Stage "${stage}" ${direction}: ${detail}`);
    this.name = 'DeclarationViolationError';
  }
}

export class StreamOwnershipError extends Error {
  constructor(readonly label: string, operation: string) {
    super(`Stream "${label}" is not owned by the caller of ${operation}`);
    this.name = 'StreamOwnershipError';
  }
}

export class DeferredOwnershipError extends Error {
  constructor(readonly deferredName: string, readonly path: string) {
    super(`Deferred "${deferredName}" at ${path} belongs to another run`);
    this.name = 'DeferredOwnershipError';
  }
}

export class DuplicateStreamCloseError extends Error {
  constructor(readonly label: string) {
    super(`Stream "${label}" has already ended or is ending`);
    this.name = 'DuplicateStreamCloseError';
  }
}

export class ConcurrentStreamReadError extends Error {
  constructor(readonly label: string) {
    super(`Stream "${label}" does not permit concurrent iterator.next() reads`);
    this.name = 'ConcurrentStreamReadError';
  }
}

export class StreamLeakError extends Error {
  constructor(readonly stageName: string, readonly labels: readonly string[]) {
    super(`Stage "${stageName}" exited without closing or exporting stream(s): ${labels.join(', ')}`);
    this.name = 'StreamLeakError';
  }
}

export class StageScopeClosedError extends Error {
  constructor(readonly stageName: string, operation: string) {
    super(`Stage "${stageName}" scope does not admit ${operation}`);
    this.name = 'StageScopeClosedError';
  }
}

export class UnsettledDeferredError extends Error {
  constructor(readonly deferredName: string) {
    super(`Deferred "${deferredName}" was pending when its owner ended`);
    this.name = 'UnsettledDeferredError';
  }
}

export class FinalizationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Pipeline finalization exceeded ${timeoutMs} ms`);
    this.name = 'FinalizationTimeoutError';
  }
}
