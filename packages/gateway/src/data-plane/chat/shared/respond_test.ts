import { beforeEach, test } from 'vitest';

import type { GatewayCtx } from './gateway-ctx.ts';
import { SourceStreamState, recordUsage } from './respond.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { recordPerformance } from '../../shared/telemetry/performance.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';
import { assertEquals, mockPerfTelemetryContext } from '@floway-dev/test-utils';

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw',
  cost: null,
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
      perfTiming: { firstOutputTokenAt, upstreamCallStartedAt, attemptTelemetry: undefined },
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
  assertEquals(rows[0].ttftSamples, 1);
  assertEquals(rows[0].tpotSamples, 1);
  assertEquals(rows[0].errors, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records TTFT-only sample when outputTokens is zero but first-token stamp fired', async () => {
  recordPerformance(harness.ctx({ upstreamCallStartedAt: 50, firstOutputTokenAt: 100 }), testPerformanceContext, false, 0, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamples, 1);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errors, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records neutral when success but firstOutputTokenAt is null', async () => {
  recordPerformance(harness.ctx({ firstOutputTokenAt: null }), testPerformanceContext, false, 50, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamples, 0);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errors, 0);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance records an error when failed', async () => {
  recordPerformance(harness.ctx({ firstOutputTokenAt: 100 }), testPerformanceContext, true, 50, 200);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ttftSamples, 0);
  assertEquals(rows[0].tpotSamples, 0);
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].requests, 1);
});

test('recordPerformance skips when performance context is absent', async () => {
  recordPerformance(harness.ctx(), undefined, true, 0, 200);
  await Promise.all(harness.background);

  assertEquals(await harness.repo.performance.listAll(), []);
});

// ── recordUsage ──

test('recordUsage records token usage for an api key', async () => {
  await recordUsage(harness.ctx(), testTelemetryModelIdentity, { input: 10, output: 5 });

  const rows = await harness.repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].keyId, 'key_a');
  assertEquals(rows[0].tokens, { input: 10, output: 5 });
  assertEquals(rows[0].requests, 1);
});

test('recordUsage is a no-op when usage is null', async () => {
  await recordUsage(harness.ctx(), testTelemetryModelIdentity, null);

  assertEquals(await harness.repo.usage.listAll(), []);
});

test('recordUsage is a no-op when usage carries no billable dimensions', async () => {
  await recordUsage(harness.ctx(), testTelemetryModelIdentity, {});

  assertEquals(await harness.repo.usage.listAll(), []);
});
