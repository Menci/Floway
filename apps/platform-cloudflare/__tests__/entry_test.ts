import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { initBackgroundSchedulerResolver } from '@floway-dev/gateway';

const { registerScheduler } = vi.hoisted(() => ({
  registerScheduler: vi.fn<typeof initBackgroundSchedulerResolver>(),
}));

vi.mock('@floway-dev/gateway', () => ({ initBackgroundSchedulerResolver: registerScheduler }));
vi.mock('../src/bootstrap.ts', () => ({ bootstrapCloudflarePlatform: vi.fn() }));

test('keeps background work alive and logs its original error after delivery', async () => {
  await import('../entry.ts');
  expect(registerScheduler).toHaveBeenCalledOnce();
  const resolveScheduler = registerScheduler.mock.calls[0]![0];
  const pending = Promise.withResolvers<void>();
  const waitUntil = vi.fn<(work: Promise<unknown>) => void>();
  const failure = new Error('background panic', { cause: new Error('original cause') });
  const host = new Hono();
  host.get('/', context => {
    resolveScheduler(context)(pending.promise);
    return context.text('delivered');
  });

  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await host.fetch(new Request('https://floway.test'), {}, { waitUntil, passThroughOnException: vi.fn(), props: {} });
    await expect(response.text()).resolves.toBe('delivered');
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    pending.reject(failure);
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![1]).toBe(failure);
  } finally {
    log.mockRestore();
  }
});
