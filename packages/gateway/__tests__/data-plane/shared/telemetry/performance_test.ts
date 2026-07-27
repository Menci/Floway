import { beforeEach, describe, expect, it, test } from 'vitest';

import type { AttemptState } from '../../../../src/data-plane/shared/gateway-ctx.ts';
import { recordPerformance } from '../../../../src/data-plane/shared/telemetry/performance.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { assertEquals, mockPerfTelemetryContext } from '@floway-dev/test-utils';

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

  // --- zero-output error ---

  it('records a zero-output error when failed=true with no output tokens', async () => {
    const ctx = ctxWith({ firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined });
    recordPerformance(ctx, telemetry, true, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errorsNoOutput: 1, ttftSamplesOk: 0, errorsWithOutput: 0, neutral: 0, tpotSamples: 0 });
  });

  // --- neutral ---

  it('records a neutral row for non-chat operation on success', async () => {
    const ctx = ctxWith({ firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined });
    recordPerformance(ctx, { ...telemetry, operation: 'embeddings' }, false, 0, 500);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, neutral: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  it('records a zero-output error for non-chat operation on failure', async () => {
    const ctx = ctxWith({ firstOutputTokenAt: null, upstreamCallStartedAt: null, telemetry: undefined });
    recordPerformance(ctx, { ...telemetry, operation: 'embeddings' }, true, 0, 500);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, errorsNoOutput: 1, ttftSamplesOk: 0, errorsWithOutput: 0, neutral: 0, tpotSamples: 0 });
  });

  it('records neutral for chat with no upstream call (synthetic result)', async () => {
    // upstreamCallStartedAt === null means no real fetch was issued (e.g. cached / synthetic).
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: null, telemetry: undefined });
    recordPerformance(ctx, telemetry, false, 50, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, neutral: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  it('records neutral for chat with upstream call but no first generated token', async () => {
    // Stream aborted or reasoning-only: upstream was called but no generated token arrived.
    const ctx = ctxWith({ firstOutputTokenAt: null, upstreamCallStartedAt: 50, telemetry: undefined });
    recordPerformance(ctx, telemetry, false, 50, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, neutral: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
  });

  // --- ttft-only sample ---

  it('records TTFT-only sample for outputTokens=1 (single-token stream)', async () => {
    // Single token gives no inter-token interval, so TPOT is skipped; TTFT is
    // still measurable and useful.
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: 50, telemetry: undefined });
    recordPerformance(ctx, telemetry, false, 1, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, ttftSamplesOk: 1, errorsWithOutput: 0, errorsNoOutput: 0, neutral: 0, tpotSamples: 0, ttftMsSum: 50, tpotUsSum: 0 });
    expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
    expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(false);
  });

  it('records TTFT-only sample for outputTokens=0 when first-token stamp fired anyway', async () => {
    // Rare upstream mismatch: detector saw an output frame but usage reports 0.
    // Honour the detector — TTFT is real, TPOT can't be computed.
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: 50, telemetry: undefined });
    recordPerformance(ctx, telemetry, false, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({ requests: 1, ttftSamplesOk: 1, errorsWithOutput: 0, errorsNoOutput: 0, neutral: 0, tpotSamples: 0, ttftMsSum: 50 });
  });

  // --- full ttft + tpot sample ---

  it('records sample with ttft measured from upstreamCallStartedAt', async () => {
    const ctx = ctxWith({ firstOutputTokenAt: 500, upstreamCallStartedAt: 100, telemetry: undefined });
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

  it('records sample with exactly 2 output tokens (boundary: outputTokens >= 2)', async () => {
    const ctx = ctxWith({ firstOutputTokenAt: 200, upstreamCallStartedAt: 100, telemetry: undefined });
    recordPerformance(ctx, telemetry, false, 2, 600);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    // TTFT = 200 - 100 = 100ms
    expect(row!.ttftMsSum).toBe(100);
    // Stream = (600 - 200) * 1000 = 400_000μs covers (N-1) = 1 inter-token interval;
    // TPOT = 400_000 / 1 = 400_000 μs/tok.
    expect(row!.tpotUsSum).toBe(400_000);
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
    const ctx = ctxWith({ firstOutputTokenAt: 500, upstreamCallStartedAt: 100, telemetry: undefined });
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

  it('records TTFT-only sample AND routes to errorsWithOutput when partial failure produced a single token', async () => {
    // outputTokens=1 gives no inter-token interval so TPOT stays 0, but TTFT
    // is real and the failure still counts. The row lands in the
    // `errorsWithOutput` partition alongside its TTFT sample.
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: 50, telemetry: undefined });
    recordPerformance(ctx, telemetry, true, 1, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({
      requests: 1,
      ttftSamplesOk: 0,
      errorsWithOutput: 1,
      errorsNoOutput: 0,
      neutral: 0,
      tpotSamples: 0,
      ttftMsSum: 50,
      tpotUsSum: 0,
    });
    expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
    expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(false);
  });

  it('records pure zero-output error (no sample) when a failure produced zero output tokens', async () => {
    // Even with a first-token stamp on the ctx (rare race), if usage reports
    // zero tokens the failure lands in the `errorsNoOutput` partition — no
    // TTFT to report, no bucket rows.
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: 50, telemetry: undefined });
    recordPerformance(ctx, telemetry, true, 0, 400);
    await Promise.all(promises);
    const [row] = await repo.performance.listAll();
    expect(row).toMatchObject({
      requests: 1,
      ttftSamplesOk: 0,
      errorsWithOutput: 0,
      errorsNoOutput: 1,
      neutral: 0,
      tpotSamples: 0,
      ttftMsSum: 0,
    });
    expect(row!.buckets).toEqual([]);
  });

  // --- no-op ---

  it('is a no-op when telemetry is undefined', async () => {
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: 50, telemetry: undefined });
    recordPerformance(ctx, undefined, false, 200, 400);
    await Promise.all(promises);
    expect(await repo.performance.listAll()).toEqual([]);
  });

  // --- invariants ---

  it('throws on negative outputTokens — an upstream that reports a negative token count is data corruption, not a value to floor', () => {
    const ctx = ctxWith({ firstOutputTokenAt: 100, upstreamCallStartedAt: 50, telemetry: undefined });
    expect(() => recordPerformance(ctx, telemetry, false, -1, 400))
      .toThrow(/negative outputTokens=-1/);
  });
});

const movedTelemetry = mockPerfTelemetryContext({
  keyId: '',
  model: 'claude-test',
  upstream: 'copilot:1',
  runtimeLocation: 'SJC',
});

let movedRepo: InMemoryRepo;
let movedBackground: Promise<unknown>[];
const movedCtx = ({ firstOutputTokenAt = null, upstreamCallStartedAt = null }: {
  firstOutputTokenAt?: number | null;
  upstreamCallStartedAt?: number | null;
} = {}) => mockGatewayCtx({
  apiKeyId: 'key_a',
  backgroundScheduler: promise => { movedBackground.push(promise); },
  attempt: { firstOutputTokenAt, upstreamCallStartedAt, telemetry: undefined },
});

beforeEach(() => {
  movedRepo = new InMemoryRepo();
  initRepo(movedRepo);
  movedBackground = [];
});

// ── recordPerformance ──

test('recordPerformance records a full sample when success with upstreamCallStartedAt, firstOutputTokenAt, and outputTokens>=2', async () => {
  recordPerformance(movedCtx({ upstreamCallStartedAt: 50, firstOutputTokenAt: 100 }), movedTelemetry, false, 50, 200);
  await Promise.all(movedBackground);

  const rows = await movedRepo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 1);
  assertEquals(rows[0].tpotSamples, 1);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].errorsNoOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records TTFT-only sample when outputTokens is zero but first-token stamp fired', async () => {
  recordPerformance(movedCtx({ upstreamCallStartedAt: 50, firstOutputTokenAt: 100 }), movedTelemetry, false, 0, 200);
  await Promise.all(movedBackground);

  const rows = await movedRepo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 1);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].errorsNoOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records neutral when success but firstOutputTokenAt is null', async () => {
  recordPerformance(movedCtx({ firstOutputTokenAt: null }), movedTelemetry, false, 50, 200);
  await Promise.all(movedBackground);

  const rows = await movedRepo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 0);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].neutral, 1);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].errorsNoOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records a zero-output error when failed without a real TTFT stamp', async () => {
  recordPerformance(movedCtx({ firstOutputTokenAt: 100 }), movedTelemetry, true, 50, 200);
  await Promise.all(movedBackground);

  const rows = await movedRepo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 0);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errorsNoOutput, 1);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance skips when performance context is absent', async () => {
  recordPerformance(movedCtx(), undefined, true, 0, 200);
  await Promise.all(movedBackground);

  assertEquals(await movedRepo.performance.listAll(), []);
});
