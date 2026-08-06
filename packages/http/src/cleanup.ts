export type CleanupOperation = () => void | PromiseLike<void>;

export const collectCleanupFailures = async (
  operations: readonly CleanupOperation[],
): Promise<readonly unknown[]> => {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
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
