import { beforeEach, expect, test } from 'vitest';

import type { GatewayCtx } from './gateway-ctx.ts';
import { SourceStreamState } from './respond.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { recordPerformance } from '../../shared/telemetry/performance.ts';
import { settle } from '../../shared/telemetry/settle.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';
import { assertEquals, mockPerfTelemetryContext } from '@floway-dev/test-utils';

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw',
  pricing: null,
};

const testPerformanceContext = mockPerfTelemetryContext({
  keyId: '',
  model: 'claude-test',
  upstream: 'copilot:1',
  runtimeLocation: 'SJC',
});

interface Harness {
  repo: InMemoryRepo;
  background: Promise<unknown>[];
  ctx: (overrides?: {
    apiKeyId?: string;
    firstOutputTokenAt?: number | null;
    upstreamCallStartedAt?: number | null;
  }) => GatewayCtx;
}

const setup = (): Harness => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const background: Promise<unknown>[] = [];
  return {
    repo,
    background,
    ctx: ({ apiKeyId = 'key_a', firstOutputTokenAt = null, upstreamCallStartedAt = null } = {}) => ({
      apiKeyId,
      upstreamIds: null,
      wantsStream: true,
      runtimeLocation: 'TEST',
      dump: null,
      responseHeaders: new Headers(),
      backgroundScheduler: promise => { background.push(promise); },
      attempt: { firstOutputTokenAt, upstreamCallStartedAt, telemetry: undefined },
    }),
  };
};

let harness: Harness;
beforeEach(() => {
  harness = setup();
});

// ── SourceStreamState classification ──

test('SourceStreamState.failedAfter classifies error completion as failed', () => {
  const state = new SourceStreamState();
  state.completed = true;

  assertEquals(state.failedAfter('error'), true);
});

test('SourceStreamState.failedAfter classifies state.failed as failed regardless of completion', () => {
  const state = new SourceStreamState();
  state.failed = true;
  state.completed = true;

  assertEquals(state.failedAfter('eof'), true);
});

test('SourceStreamState.failedAfter classifies cancel-before-complete as failed', () => {
  const state = new SourceStreamState();
  state.completed = false;

  assertEquals(state.failedAfter('cancel'), true);
});

test('SourceStreamState.failedAfter treats cancel-after-complete as graceful', () => {
  const state = new SourceStreamState();
  state.completed = true;

  assertEquals(state.failedAfter('cancel'), false);
});

test('SourceStreamState.failedAfter treats clean EOF as graceful', () => {
  const state = new SourceStreamState();
  state.completed = true;

  assertEquals(state.failedAfter('eof'), false);
});

// ── SourceStreamState.rememberUsage ──

test('SourceStreamState.rememberUsage keeps real usage and ignores zero figures', () => {
  const state = new SourceStreamState();
  state.rememberUsage({ input: 50, output: 10 });
  assertEquals(state.usage, { input: 50, output: 10 });

  state.rememberUsage({});
  assertEquals(state.usage, { input: 50, output: 10 });

  state.rememberUsage(null);
  assertEquals(state.usage, { input: 50, output: 10 });

  state.rememberUsage({ input: 0, output: 0 });
  assertEquals(state.usage, { input: 50, output: 10 });
});

// ── recordPerformance ──

test('recordPerformance records a full sample when success with upstreamCallStartedAt, firstOutputTokenAt, and outputTokens>=2', async () => {
  recordPerformance(harness.ctx({ upstreamCallStartedAt: 50, firstOutputTokenAt: 100 }), testPerformanceContext, false, 50, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 1);
  assertEquals(rows[0].tpotSamples, 1);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].errorsNoOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records TTFT-only sample when outputTokens is zero but first-token stamp fired', async () => {
  recordPerformance(harness.ctx({ upstreamCallStartedAt: 50, firstOutputTokenAt: 100 }), testPerformanceContext, false, 0, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 1);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].errorsNoOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records neutral when success but firstOutputTokenAt is null', async () => {
  recordPerformance(harness.ctx({ firstOutputTokenAt: null }), testPerformanceContext, false, 50, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 0);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].neutral, 1);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].errorsNoOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records a zero-output error when failed without a real TTFT stamp', async () => {
  recordPerformance(harness.ctx({ firstOutputTokenAt: 100 }), testPerformanceContext, true, 50, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamplesOk, 0);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errorsNoOutput, 1);
  assertEquals(rows[0].errorsWithOutput, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance skips when performance context is absent', async () => {
  recordPerformance(harness.ctx(), undefined, true, 0, 200);
  await Promise.all(harness.background);

  assertEquals(await harness.repo.performance.listAll(), []);
});

// ── settle ──

test('settle records a usage row when the figure carries a billable dimension', async () => {
  settle(harness.ctx(), testPerformanceContext, testTelemetryModelIdentity, { input: 10, output: 5 }, false);
  await Promise.all(harness.background);

  const rows = await harness.repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].keyId, 'key_a');
  assertEquals(rows[0].tokens, { input: 10, output: 5 });
  assertEquals(rows[0].requests, 1);
});

test('settle skips the usage row when usage is null', async () => {
  settle(harness.ctx(), testPerformanceContext, testTelemetryModelIdentity, null, false);
  await Promise.all(harness.background);

  assertEquals(await harness.repo.usage.listAll(), []);
});

test('settle skips the usage row when usage carries no billable dimension', async () => {
  settle(harness.ctx(), testPerformanceContext, testTelemetryModelIdentity, {}, false);
  await Promise.all(harness.background);

  assertEquals(await harness.repo.usage.listAll(), []);
});

// TPOT reflects the token stream, not the D1 write that follows it.
// `settle` fires the usage record through backgroundScheduler and records
// the perf sample synchronously — so a slow persistence path cannot leak
// its latency into `tpotUs`. Regressing this (turning the usage record
// back into an in-band await, or moving the perf record past the
// scheduler call) would fold persistence latency into every stream's
// per-token interval.
test('settle records the perf sample without waiting on the usage write', async () => {
  const originalRecord = harness.repo.usage.record.bind(harness.repo.usage);
  const persistenceDelayMs = 200;
  harness.repo.usage.record = async row => {
    await new Promise(resolve => setTimeout(resolve, persistenceDelayMs));
    await originalRecord(row);
  };

  const beforeSettle = performance.now();
  const ctx = harness.ctx({ upstreamCallStartedAt: beforeSettle - 10, firstOutputTokenAt: beforeSettle });

  settle(ctx, testPerformanceContext, testTelemetryModelIdentity, { input: 5, output: 3 }, false);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  // TPOT = (requestFinishedAt - firstOutputTokenAt) * 1000 / (outputTokens - 1).
  // Recorded synchronously at settle entry: tpotUs reflects only the
  // sub-millisecond gap between ctx construction and settle. Fold the
  // 200ms usage write into it (in-band await) and tpotUs would be
  // ~100_000us (200ms / 2). 50_000us fences the regression while
  // tolerating scheduler jitter.
  expect(rows[0].tpotUsSum).toBeLessThan(50_000);
});
