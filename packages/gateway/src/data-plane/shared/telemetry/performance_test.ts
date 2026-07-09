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

  // --- error ---

  it('records an error when failed=true', async () => {
    const ctx = { firstOutputTokenAt: null, upstreamCallStartedAt: null };
    recordRequestPerformance(scheduler, ctx, telemetry, true, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ errors: 1, samples: 0 });
  });

  // --- neutral ---

  it('records a neutral row for non-chat operation on success', async () => {
    const ctx = { firstOutputTokenAt: null, upstreamCallStartedAt: null };
    recordRequestPerformance(scheduler, ctx, { ...telemetry, operation: 'embeddings' }, false, 0, 500);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errors: 0, samples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  it('records an error row for non-chat operation on failure', async () => {
    const ctx = { firstOutputTokenAt: null, upstreamCallStartedAt: null };
    recordRequestPerformance(scheduler, ctx, { ...telemetry, operation: 'embeddings' }, true, 0, 500);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errors: 1, samples: 0 });
  });

  it('records neutral for chat with no upstream call (synthetic result)', async () => {
    // upstreamCallStartedAt === null means no real fetch was issued (e.g. cached / synthetic).
    const ctx = { firstOutputTokenAt: 100, upstreamCallStartedAt: null };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 50, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errors: 0, samples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  it('records neutral for chat with upstream call but no first generated token', async () => {
    // Stream aborted or reasoning-only: upstream was called but no generated token arrived.
    const ctx = { firstOutputTokenAt: null, upstreamCallStartedAt: 50 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 50, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errors: 0, samples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  it('records neutral for chat with outputTokens=1 (single-token stream, tpot unmeasurable)', async () => {
    // With only one output token the stream duration divided by 1 gives tpot ≈ 0 μs,
    // polluting histogram buckets — treat as neutral instead.
    const ctx = { firstOutputTokenAt: 100, upstreamCallStartedAt: 50 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 1, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errors: 0, samples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  it('records neutral for chat with outputTokens=0 (client disconnect before any output)', async () => {
    const ctx = { firstOutputTokenAt: 100, upstreamCallStartedAt: 50 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errors: 0, samples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  // --- sample ---

  it('records sample with ttft measured from upstreamCallStartedAt', async () => {
    const ctx = { firstOutputTokenAt: 500, upstreamCallStartedAt: 100 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 200, 1000);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    // TTFT = firstOutputTokenAt - upstreamCallStartedAt = 500 - 100 = 400ms
    expect(row!.ttftMsSum).toBe(400);
    // Stream = (1000 - 500) * 1000 = 500_000μs; TPOT = 500_000 / 200 = 2_500 μs/tok
    expect(row!.tpotUsSum).toBe(2_500);
    expect(row).toMatchObject({ requests: 1, samples: 1, errors: 0 });
  });

  it('records sample with exactly 2 output tokens (boundary: outputTokens >= 2)', async () => {
    const ctx = { firstOutputTokenAt: 200, upstreamCallStartedAt: 100 };
    recordRequestPerformance(scheduler, ctx, telemetry, false, 2, 600);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    // TTFT = 200 - 100 = 100ms
    expect(row!.ttftMsSum).toBe(100);
    // Stream = (600 - 200) * 1000 = 400_000μs; TPOT = 400_000 / 2 = 200_000 μs/tok
    expect(row!.tpotUsSum).toBe(200_000);
    expect(row).toMatchObject({ requests: 1, samples: 1, errors: 0 });
  });

  // --- no-op ---

  it('is a no-op when telemetry is undefined', async () => {
    const ctx = { firstOutputTokenAt: 100, upstreamCallStartedAt: 50 };
    recordRequestPerformance(scheduler, ctx, undefined, false, 200, 400);
    await Promise.all(promises);
    expect(await repo.performance.listAll()).toEqual([]);
  });
});
