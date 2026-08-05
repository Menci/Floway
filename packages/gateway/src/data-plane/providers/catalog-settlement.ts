import { isAbortError } from '@floway-dev/provider';

// Catalog fanout tolerates an ordinary provider failure so healthy siblings
// can still contribute models. Cancellation is different: it belongs to the
// caller and must reject immediately even when another provider never settles.
export const settleCatalogTasks = async <T>(tasks: readonly (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> =>
  await Promise.all(tasks.map(async task => {
    try {
      return { status: 'fulfilled', value: await task() } as const;
    } catch (reason) {
      if (isAbortError(reason)) throw reason;
      return { status: 'rejected', reason } as const;
    }
  }));
