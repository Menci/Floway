import { isAbortError } from '@floway-dev/provider';

// Catalog fan-outs tolerate an individual upstream failure, but cancellation
// belongs to the whole request. Wrapping each task converts ordinary failures
// into settled results while leaving AbortError as a rejection of Promise.all,
// so an uncooperative sibling cannot delay cancellation indefinitely.
export const settleUnlessAborted = async <T>(
  tasks: readonly Promise<T>[],
): Promise<PromiseSettledResult<T>[]> => await Promise.all(tasks.map(async task => {
  try {
    return { status: 'fulfilled', value: await task } as const;
  } catch (reason) {
    if (isAbortError(reason)) throw reason;
    return { status: 'rejected', reason } as const;
  }
}));
