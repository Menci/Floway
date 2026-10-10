import { expect, it, vi } from 'vitest';

import { createUpstreamUsageRecorder } from '../../src/upstream-usage/recorder.ts';
import { InMemoryRepo } from '../repo/memory.ts';

it('propagates the original storage failure and retries an unchanged observation', async () => {
  const repo = new InMemoryRepo();
  vi.spyOn(repo.upstreams, 'getById').mockResolvedValue({ kind: 'copilot', name: 'Seat', hue: 210 } as never);
  const error = new Error('Database unavailable');
  const persist = vi.spyOn(repo.upstreamUsageMetrics, 'record').mockRejectedValueOnce(error);
  const record = createUpstreamUsageRecorder(repo);
  await expect(record('up-1', 'premium_interactions', 20, 1_000)).rejects.toBe(error);
  await record('up-1', 'premium_interactions', 20, 1_000);
  expect(persist).toHaveBeenCalledTimes(2);
  expect(await repo.upstreamUsageMetrics.query(0, 2_000)).toMatchObject([{ upstreamId: 'up-1', value: 20 }]);
});

it('does not resurrect an upstream deleted during an observation', async () => {
  const repo = new InMemoryRepo();
  const persist = vi.spyOn(repo.upstreamUsageMetrics, 'record');
  await createUpstreamUsageRecorder(repo)('gone', 'premium_interactions', 20, 1_000);
  expect(persist).not.toHaveBeenCalled();
});

it('rejects invalid observations at the recording boundary', async () => {
  const record = createUpstreamUsageRecorder(new InMemoryRepo());
  for (const [key, value, timestamp] of [['', 20, 1_000], ['usage', NaN, 1_000], ['usage', 20, -1], ['usage', 20, 0.5]] as const) {
    await expect(record('up-1', key, value, timestamp)).rejects.toThrow(TypeError);
  }
});
