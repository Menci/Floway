import { act } from '@testing-library/react';
import { vi } from 'vitest';

// Captured while the real timers are still installed, so a settle is a genuine
// macrotask hop whether or not the suite has since installed fake ones. That is
// what makes one drain enough: every microtask queued before it -- and every
// continuation those queue in turn -- has run by the time the callback fires,
// so a chain gaining another `await` cannot make a suite go red.
const macrotask = globalThis.setTimeout.bind(globalThis);

// Lets React flush everything the current work has already queued, without
// moving a faked clock.
export const settle = async (): Promise<void> => {
  await act(async () => { await new Promise(resolve => { macrotask(resolve, 0); }); });
};

// Moves a faked clock and runs what falls due. The async form is the single one
// the suites use: it also flushes the promises those timer callbacks queue,
// which the synchronous `advanceTimersByTime` leaves pending.
export const advance = async (ms: number): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
