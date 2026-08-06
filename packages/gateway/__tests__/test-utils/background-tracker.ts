// Background-task tracker for vitest. Wired by `vitest.setup.ts`'s
// `initBackgroundSchedulerResolver`, exposed here so tests can deterministically
// await every in-flight background promise instead of polling real timers.
const pending = new Set<Promise<unknown>>();
const failures: unknown[] = [];

export const trackBackground = (promise: Promise<unknown>): void => {
  const tracked = promise.catch(error => {
    failures.push(error);
  }).finally(() => {
    pending.delete(tracked);
  });
  pending.add(tracked);
};

const settleBackground = async (): Promise<unknown[]> => {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
  return failures.splice(0);
};

const backgroundFailure = (errors: readonly unknown[]): unknown =>
  errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `${errors.length} background tasks failed`);

export const flushBackground = async (): Promise<void> => {
  const errors = await settleBackground();
  if (errors.length > 0) throw backgroundFailure(errors);
};

export const flushBackgroundExpectingFailures = async (...expected: readonly unknown[]): Promise<void> => {
  const actual = await settleBackground();
  const matches = actual.length === expected.length && actual.every((error, index) => error === expected[index]);
  if (matches) return;
  throw new AggregateError(
    actual,
    `Expected ${expected.length} background failures by identity, received ${actual.length}`,
  );
};
