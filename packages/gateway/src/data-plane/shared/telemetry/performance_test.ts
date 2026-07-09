// packages/gateway/src/data-plane/shared/telemetry/performance_test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import { recordRequestPerformance } from './performance.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';

const telemetry: PerformanceTelemetryContext = {
  keyId: 'key_a',
  model: 'claude-opus-4-8',
  upstream: 'anthropic-1',
  operation: 'chat',
  modelKey: 'claude-opus-4-8-2026-06-30',
  runtimeLocation: 'hkg',
};

describe('recordRequestPerformance', () => {
  let repo: InMemoryRepo;
  const promises: Promise<unknown>[] = [];
  const scheduler = (p: Promise<unknown>) => { promises.push(p); };

  beforeEach(() => {
    repo = new InMemoryRepo();
    initRepo(repo);
    promises.length = 0;
  });

  it('records a sample with ttft + tpot on a successful stream', async () => {
    const ctx = { perfTiming: { firstOutputTokenAt: 100 }, requestStartedAt: 0 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 200, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ samples: 1, errors: 0, ttftMsSum: 100 });
    // Stream duration = 400 - 100 = 300ms = 300_000μs; tpot = 300_000 / 200 = 1500 μs/tok.
    expect(row!.tpotUsSum).toBe(1_500);
  });

  it('records an error when failed=true', async () => {
    const ctx = { perfTiming: { firstOutputTokenAt: null }, requestStartedAt: 0 };
    recordRequestPerformance(scheduler, ctx, telemetry, true, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ errors: 1, samples: 0 });
  });

  it('records an error when success but firstOutputTokenAt never fired', async () => {
    const ctx = { perfTiming: { firstOutputTokenAt: null }, requestStartedAt: 0 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 50, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ errors: 1, samples: 0 });
  });

  it('records an error when outputTokens is 0', async () => {
    const ctx = { perfTiming: { firstOutputTokenAt: 100 }, requestStartedAt: 0 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ errors: 1, samples: 0 });
  });

  it('is a no-op when telemetry is undefined', async () => {
    const ctx = { perfTiming: { firstOutputTokenAt: 100 }, requestStartedAt: 0 };
    recordRequestPerformance(scheduler, ctx, undefined, false, 200, 400);
    await Promise.all(promises);
    expect(await repo.performance.listAll()).toEqual([]);
  });
});
