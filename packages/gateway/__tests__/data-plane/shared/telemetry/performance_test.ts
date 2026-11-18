import { beforeEach, describe, expect, it } from 'vitest';

import type { AttemptState } from '../../../../src/data-plane/shared/gateway-ctx.ts';
import { recordPerformance } from '../../../../src/data-plane/shared/telemetry/performance.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { mockPerfTelemetryContext } from '@floway-dev/test-utils';

const telemetry = mockPerfTelemetryContext({
  keyId: 'key_a',
  model: 'claude-opus-4-8',
  upstream: 'anthropic-1',
  runtimeLocation: 'hkg',
});

describe('recordPerformance', () => {
  let repo: InMemoryRepo;
  const promises: Promise<unknown>[] = [];
  const scheduler = (p: Promise<unknown>) => { promises.push(p); };
  const ctxWith = (attempt: AttemptState) => mockGatewayCtx({ attempt, backgroundScheduler: scheduler });

  beforeEach(() => {
    repo = new InMemoryRepo();
    initRepo(repo);
    promises.length = 0;
  });

  // --- full ttft + tpot sample ---

  it('records sample with ttft measured from upstreamCallStartedAt', async () => {
    const ctx = ctxWith({ timing: { firstOutputTokenAt: 500, upstreamCallStartedAt: 100 }, telemetry: undefined });
    recordPerformance(ctx, telemetry, false, 200, 1000);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    // TTFT = firstOutputTokenAt - upstreamCallStartedAt = 500 - 100 = 400ms
    expect(row!.ttftMsSum).toBe(400);
    // Stream = (1000 - 500) * 1000 = 500_000μs covers (N-1) = 199 inter-token intervals;
    // TPOT = 500_000 / 199 ≈ 2513 μs/tok.
    expect(row!.tpotUsSum).toBe(2_513);
    expect(row).toMatchObject({ requests: 1, ttftSamplesOk: 1, errorsWithOutput: 0, tpotSamples: 1 });
  });

  // --- partial-output failure ---

  it('records TTFT+TPOT sample AND routes to errorsWithOutput when a stream fails after emitting tokens', async () => {
    // Mid-stream failure that produced output: the recorder MUST expose
    // the observed latency (TTFT + TPOT) as a sample AND count against errors,
    // in one atomic upsert. The partition-first partition lands it in
    // `errorsWithOutput` — a disjoint counter that never overlaps
    // `ttftSamplesOk`, so the aggregator derives `errors` and `ttftSamples`
    // without inclusion-exclusion.
    const ctx = ctxWith({ timing: { firstOutputTokenAt: 500, upstreamCallStartedAt: 100 }, telemetry: undefined });
    recordPerformance(ctx, telemetry, true, 200, 1000);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({
      requests: 1,
      ttftSamplesOk: 0,
      errorsWithOutput: 1,
      errorsNoOutput: 0,
      neutral: 0,
      tpotSamples: 1,
    });
    expect(row!.ttftMsSum).toBe(400);
    expect(row!.tpotUsSum).toBe(2_513);
    expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
    expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(true);
  });

  // --- invariants ---

  it('throws on negative outputTokens — an upstream that reports a negative token count is data corruption, not a value to floor', () => {
    const ctx = ctxWith({ timing: { firstOutputTokenAt: 100, upstreamCallStartedAt: 50 }, telemetry: undefined });
    expect(() => recordPerformance(ctx, telemetry, false, -1, 400))
      .toThrow(/negative outputTokens=-1/);
  });
});
