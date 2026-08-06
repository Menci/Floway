// Reshape an already-aborted signal into a throwable Error. A structured
// Error reason rethrows as-is so its stack/cause survive; a primitive or
// absent reason becomes a DOMException('AbortError').
import { CLEANUP_OPERATION_DEADLINE_MS, CleanupTimeoutError } from './cleanup.ts';

export const signalAbortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? 'aborted'), 'AbortError');
};

export const failureContains = (failure: unknown, target: unknown): boolean => {
  const pending: unknown[] = [failure];
  const seen = new Set<object>();
  for (let visited = 0; pending.length > 0 && visited < 64; visited++) {
    const current = pending.shift();
    if (Object.is(current, target)) return true;
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    try {
      const cause = Object.getOwnPropertyDescriptor(current, 'cause');
      if (cause !== undefined && 'value' in cause) pending.push(cause.value);
      const errors = Object.getOwnPropertyDescriptor(current, 'errors');
      if (errors === undefined || !('value' in errors) || !Array.isArray(errors.value)) continue;
      for (let index = 0; index < Math.min(errors.value.length, 64); index++) {
        const item = Object.getOwnPropertyDescriptor(errors.value, String(index));
        if (item !== undefined && 'value' in item) pending.push(item.value);
      }
    } catch {
      return false;
    }
  }
  return false;
};

export const failureForSignalAbort = (
  signal: AbortSignal,
  caught: unknown,
  message: string,
): unknown => {
  const reason = signalAbortReason(signal);
  if (failureContains(caught, reason)) return caught;
  return new AggregateError([reason, caught], message, { cause: reason });
};

type PromptCleanupOutcome =
  | { readonly type: 'settled' }
  | { readonly type: 'failed'; readonly error: unknown };

export interface PromptCleanupObservation {
  readonly context: string;
  readonly settlement: Promise<PromptCleanupOutcome>;
  outcome: PromptCleanupOutcome | undefined;
}

// Abort must be prompt even when a Web Streams sink ignores cancellation.
// Start teardown synchronously, observe through one explicit task boundary so
// immediate/microtask/next-task failures can join the caller's error chain,
// then keep a handler attached and report any later failure at a stable
// top-level sink. A never-settling cleanup therefore cannot pin the caller.
export const startPromptCleanup = (
  context: string,
  operation: () => void | PromiseLike<void>,
): PromptCleanupObservation => {
  let result: void | PromiseLike<void>;
  try {
    result = operation();
  } catch (error) {
    const outcome = { type: 'failed' as const, error };
    return { context, outcome, settlement: Promise.resolve(outcome) };
  }
  let observation!: PromptCleanupObservation;
  const settlement = Promise.resolve(result).then<PromptCleanupOutcome, PromptCleanupOutcome>(
    () => ({ type: 'settled' }),
    error => ({ type: 'failed', error }),
  ).then(outcome => {
    observation.outcome = outcome;
    return outcome;
  });
  observation = { context, settlement, outcome: undefined };
  return observation;
};

export const collectPromptCleanupFailures = async (
  observations: readonly PromptCleanupObservation[],
  primary: unknown,
): Promise<readonly unknown[]> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.resolve();
  const failures: unknown[] = [];
  const append = (failure: unknown): void => {
    if (Object.is(failure, primary) || failures.some(existing => Object.is(existing, failure))) return;
    failures.push(failure);
  };
  for (const observation of observations) {
    if (observation.outcome?.type === 'failed') {
      append(observation.outcome.error);
      continue;
    }
    if (observation.outcome !== undefined) continue;
    const timeoutId = setTimeout(() => {
      console.error(
        `[abort-cleanup] ${observation.context} did not settle after prompt abort:`,
        new CleanupTimeoutError(0, CLEANUP_OPERATION_DEADLINE_MS),
      );
    }, CLEANUP_OPERATION_DEADLINE_MS);
    if (typeof timeoutId === 'object' && 'unref' in timeoutId) timeoutId.unref();
    void observation.settlement.then(outcome => {
      clearTimeout(timeoutId);
      if (outcome.type === 'failed' && !Object.is(outcome.error, primary)) {
        console.error(`[abort-cleanup] ${observation.context} failed after prompt abort settlement:`, outcome.error);
      }
    });
  }
  return failures;
};
