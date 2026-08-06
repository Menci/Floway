// Reshape an already-aborted signal into a throwable Error. A structured
// Error reason rethrows as-is so its stack/cause survive; a primitive or
// absent reason becomes a DOMException('AbortError').
export const signalAbortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? 'aborted'), 'AbortError');
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
    void observation.settlement.then(outcome => {
      if (outcome.type === 'failed' && !Object.is(outcome.error, primary)) {
        console.error(`[abort-cleanup] ${observation.context} failed after prompt abort settlement:`, outcome.error);
      }
    });
  }
  return failures;
};
