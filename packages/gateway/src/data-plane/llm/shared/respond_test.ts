import { beforeEach, test } from 'vitest';

import type { GatewayCtx } from './gateway-ctx.ts';
import { SourceStreamState, recordPerformance, recordUsage } from './respond.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw',
  cost: null,
};

const testPerformanceContext: PerformanceTelemetryContext = {
  keyId: '',
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw',
  stream: true,
  runtimeLocation: 'SJC',
};

interface Harness {
  repo: InMemoryRepo;
  background: Promise<unknown>[];
  ctx: (overrides?: { apiKeyId?: string; requestStartedAt?: number }) => GatewayCtx;
}

const setup = (): Harness => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const background: Promise<unknown>[] = [];
  return {
    repo,
    background,
    ctx: ({ apiKeyId = 'key_a', requestStartedAt = 0 } = {}) => ({
      apiKeyId,
      upstreamIds: null,
      wantsStream: true,
      runtimeLocation: 'TEST',
      currentColo: 'TEST',
      dump: null,
      backgroundScheduler: promise => { background.push(promise); },
      requestStartedAt,
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

test('recordPerformance records latency when not failed', async () => {
  recordPerformance(harness.ctx({ requestStartedAt: performance.now() - 25 }), testPerformanceContext, false);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].metricScope, 'request_total');
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].errors, 0);
});

test('recordPerformance records an error when failed', async () => {
  recordPerformance(harness.ctx(), testPerformanceContext, true);
  await Promise.all(harness.background);

  const rows = await harness.repo.performance.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].metricScope, 'request_total');
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].requests, 0);
});

test('recordPerformance skips when performance context is absent', async () => {
  recordPerformance(harness.ctx(), undefined, true);
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
