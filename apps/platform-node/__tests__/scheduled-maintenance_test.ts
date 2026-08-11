import { readFileSync } from 'node:fs';

import { expect, test, vi } from 'vitest';

import { scheduleMaintenance } from '../src/scheduled-maintenance.ts';

test('the Node entry registers scheduled maintenance with the process timers', () => {
  const entry = readFileSync(new URL('../entry.ts', import.meta.url), 'utf8');
  expect(entry).toContain('scheduleMaintenance(runScheduledMaintenance, { setTimeout, setInterval });');
});

test('maintenance starts after 30 seconds and repeats every minute', async () => {
  const startup = { callback: null as (() => void) | null, unref: vi.fn() };
  const interval = { callback: null as (() => void) | null, unref: vi.fn() };
  const runMaintenance = vi.fn<() => Promise<void>>().mockResolvedValue();

  scheduleMaintenance(runMaintenance, {
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
