import { afterEach, expect, test, vi } from 'vitest';

import { startScheduledMaintenance } from '../src/scheduled-maintenance.ts';
import { runScheduledMaintenance } from '@floway-dev/gateway';

vi.mock('@floway-dev/gateway', () => ({
  runScheduledMaintenance: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test('maintenance starts after 30 seconds and repeats every minute', async () => {
  const startup = { callback: null as (() => void) | null, unref: vi.fn() };
  const interval = { callback: null as (() => void) | null, unref: vi.fn() };
  const runMaintenance = vi.fn<() => Promise<void>>().mockResolvedValue();

  startScheduledMaintenance(runMaintenance, {
    setTimeout(callback, delayMs) {
      expect(delayMs).toBe(30_000);
      startup.callback = callback;
      return startup;
    },
    setInterval(callback, delayMs) {
      expect(delayMs).toBe(60_000);
      interval.callback = callback;
      return interval;
    },
  });

  expect(startup.unref).toHaveBeenCalledOnce();
  expect(interval.unref).toHaveBeenCalledOnce();
  startup.callback?.();
  interval.callback?.();
  await vi.waitFor(() => expect(runMaintenance).toHaveBeenCalledTimes(2));
});

test('production defaults schedule the gateway maintenance callback', async () => {
  const callbacks: Array<() => void> = [];
  const handle = setTimeout(() => {}, 60_000);
  clearTimeout(handle);
  const unref = vi.spyOn(handle, 'unref');
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(callback => {
    callbacks.push(callback as () => void);
    return handle;
  });
  vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
    callbacks.push(callback as () => void);
    return handle;
  });

  startScheduledMaintenance();
  callbacks.forEach(callback => callback());

  expect(unref).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(runScheduledMaintenance).toHaveBeenCalledTimes(2));
});
