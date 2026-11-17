import { expect, it, vi } from 'vitest';

import { createUpstreamMetricsRecorder } from '../../src/upstream-metrics/recorder.ts';
import { InMemoryRepo } from '../repo/memory.ts';

it('propagates the original storage failure and retries an unchanged observation', async () => {
  const repo = new InMemoryRepo();
  const error = new Error('Database unavailable');
  const persist = vi.spyOn(repo.upstreamMetrics, 'record').mockRejectedValueOnce(error);
  const record = createUpstreamMetricsRecorder(repo);
  await expect(record('up-1', 'quota.remaining', { quota: 'premium_interactions' }, 20, 1_000)).rejects.toBe(error);
  await record('up-1', 'quota.remaining', { quota: 'premium_interactions' }, 20, 1_000);
  expect(persist).toHaveBeenCalledTimes(2);
  expect(await repo.upstreamMetrics.query('up-1', 0, 2_000, 60_000)).toMatchObject([{ upstreamId: 'up-1', value: 20 }]);
});

it('rejects invalid observations at the recording boundary', async () => {
  const record = createUpstreamMetricsRecorder(new InMemoryRepo());
  await expect(record('up-1', 'metric', {}, NaN, 1_000)).rejects.toThrow(TypeError);
  await expect(record('up-1', 'metric', {}, Infinity, 1_000)).rejects.toThrow(TypeError);
  await expect(record('up-1', 'metric', {}, 20, -1)).rejects.toThrow(TypeError);
  await expect(record('up-1', 'metric', {}, 20, 0.5)).rejects.toThrow(TypeError);
  for (const [name, labels] of [['', {}], ['metric', []], ['metric', { nested: {} }], ['metric', { missing: undefined }], ['metric', { infinite: Infinity }]] as const) {
    await expect(record('up-1', name, labels as never, 20, 1_000)).rejects.toThrow(TypeError);
  }
});
