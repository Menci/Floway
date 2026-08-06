export type CleanupOperation = () => void | PromiseLike<void>;

export const CLEANUP_OPERATION_DEADLINE_MS = 5_000;

export class CleanupTimeoutError extends Error {
  readonly operationIndex: number;
  readonly timeoutMs: number;

  constructor(operationIndex: number, timeoutMs: number) {
    super(`Cleanup operation ${operationIndex} did not settle within ${timeoutMs}ms`);
    this.name = 'CleanupTimeoutError';
    this.operationIndex = operationIndex;
    this.timeoutMs = timeoutMs;
  }
}

export interface CleanupOptions {
  readonly timeoutMs?: number;
}

export const collectCleanupFailures = async (
  operations: readonly CleanupOperation[],
  options: CleanupOptions = {},
): Promise<readonly unknown[]> => {
  const timeoutMs = options.timeoutMs ?? CLEANUP_OPERATION_DEADLINE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 0x7fffffff) {
    throw new TypeError(`Cleanup timeout must be an integer from 0 to 2147483647, got ${timeoutMs}`);
  }
  const deadline = Date.now() + timeoutMs;
  const failures: unknown[] = [];
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
    const operation = operations[operationIndex]!;
    const pending = Promise.resolve().then(operation).then(
      () => ({ type: 'settled' as const }),
      error => ({ type: 'failed' as const, error }),
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly type: 'timeout' }>(resolve => {
      timeoutId = setTimeout(
        () => resolve({ type: 'timeout' }),
        Math.max(0, deadline - Date.now()),
      );
    });
    const result = await Promise.race([pending, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (result.type === 'failed') {
      failures.push(result.error);
    } else if (result.type === 'timeout') {
      // `pending` already owns both fulfillment and rejection handlers. A late
      // failure is therefore observed even though the caller proceeds with a
      // bounded timeout error and the remaining cleanup operations.
      failures.push(new CleanupTimeoutError(operationIndex, timeoutMs));
    }
  }
  return failures;
};

export const cleanupFailure = (
  failures: readonly unknown[],
  message: string,
): unknown => {
  if (failures.length === 0) throw new TypeError('cleanupFailure requires at least one failure');
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message, { cause: failures[0] });
};

export const failureWithCleanup = (
  primary: unknown,
  cleanupFailures: readonly unknown[],
  message: string,
): unknown =>
  cleanupFailures.length === 0
    ? primary
    : new AggregateError([primary, ...cleanupFailures], message, { cause: primary });
