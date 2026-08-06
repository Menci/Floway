export type CleanupOperation = () => void | PromiseLike<void>;

// Transport teardown gets five seconds to settle. This leaves most of
// Cloudflare's 30-second post-disconnect `waitUntil()` allowance available to
// gateway finalization while preventing a broken reader or socket from holding
// every remaining cleanup operation indefinitely.
// https://github.com/cloudflare/cloudflare-docs/blob/f8ac0aa6d9ef268d442865225c786753aa1332af/src/content/docs/workers/platform/limits.mdx#L152-L168
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

export const collectCleanupFailures = async (
  operations: readonly CleanupOperation[],
): Promise<readonly unknown[]> => {
  const timeoutMs = CLEANUP_OPERATION_DEADLINE_MS;
  const deadline = performance.now() + timeoutMs;
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
        Math.max(0, deadline - performance.now()),
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
