import { vi } from 'vitest';

import { RETAINED_RESPONSE_LIMITS } from '../../../src/data-plane/shared/retained-response.ts';
import { assertEquals } from '@floway-dev/test-utils';

const realClearTimeout = globalThis.clearTimeout;

export const observeExecutionTimers = () => {
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  const executionTimers = (): Array<ReturnType<typeof setTimeout>> => setTimeoutSpy.mock.calls
    .flatMap((call, index) => call[1] === RETAINED_RESPONSE_LIMITS.totalTimeoutMs
      ? [setTimeoutSpy.mock.results[index].value as ReturnType<typeof setTimeout>]
      : []);

  return {
    assertLifecycleCount(expected: number): void {
      const timers = executionTimers();
      assertEquals(timers.length, expected);
      for (const timer of timers) {
        assertEquals(clearTimeoutSpy.mock.calls.filter(([candidate]) => candidate === timer).length, 1);
      }
    },
    assertNoLifecycleStarted(): void {
      assertEquals(executionTimers().length, 0);
    },
    cleanup(): void {
      for (const timer of executionTimers()) realClearTimeout(timer);
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    },
  };
};
