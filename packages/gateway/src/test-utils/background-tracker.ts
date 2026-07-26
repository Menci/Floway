// Background-task tracker for vitest. Wired by `vitest.setup.ts`'s
// `initBackgroundSchedulerResolver`, exposed here so tests can deterministically
// await every in-flight background promise instead of polling real timers.
const pending = new Set<Promise<unknown>>();

export const trackBackground = (promise: Promise<unknown>): void => {
  const tracked = promise.catch(err => {
    console.error('[background]', err);
  }).finally(() => {
    pending.delete(tracked);
  });
  pending.add(tracked);
};

export const flushBackground = async (): Promise<void> => {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
};
