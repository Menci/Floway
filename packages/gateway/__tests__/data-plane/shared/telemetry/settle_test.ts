import { beforeEach, expect, test, vi } from 'vitest';

import { settle, settleUsageMeasurement } from '../../../../src/data-plane/shared/telemetry/settle.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
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

let repo: InMemoryRepo;
let background: Promise<unknown>[];
const ctx = ({ firstOutputTokenAt = null, upstreamCallStartedAt = null }: {
  firstOutputTokenAt?: number | null;
  upstreamCallStartedAt?: number | null;
} = {}) => mockGatewayCtx({
  apiKeyId: 'key_a',
  backgroundScheduler: promise => { background.push(promise); },
  attempt: { timing: { firstOutputTokenAt, upstreamCallStartedAt }, telemetry: undefined },
});

beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
  background = [];
});

// ── settle ──

test('settle records a usage row when the figure carries a billable metric', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, { input: 10, output: 5 }, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].keyId, 'key_a');
  assertEquals(tokenCountsFromUsage(rows[0]), { input: 10, output: 5 });
  assertEquals(rows[0].requests, 1);
});

test('settle records the request without metrics when usage is null', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, null, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, []);
});

test('settle records the request when usage carries no billable metric', async () => {
  settle(ctx(), testPerformanceContext, testTelemetryModelIdentity, {}, false);
  await Promise.all(background);

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, []);
});

// TPOT reflects the token stream, not the D1 write that follows it.
// `settle` fires the usage record through backgroundScheduler and records
// the perf sample synchronously — so a slow persistence path cannot leak
// its latency into `tpotUs`. Regressing this (turning the usage record
// back into an in-band await, or moving the perf record past the
// scheduler call) would fold persistence latency into every stream's
// per-token interval.
test('settle records the perf sample without waiting on the usage write', async () => {
  const originalRecord = repo.usage.record.bind(repo.usage);
  const persistenceDelayMs = 200;
  repo.usage.record = async row => {
    await new Promise(resolve => setTimeout(resolve, persistenceDelayMs));
    await originalRecord(row);
  };

  const beforeSettle = performance.now();
  const gatewayCtx = ctx({ upstreamCallStartedAt: beforeSettle - 10, firstOutputTokenAt: beforeSettle });

  settle(gatewayCtx, testPerformanceContext, testTelemetryModelIdentity, { input: 5, output: 3 }, false);
  await Promise.all(background);

  const rows = await repo.performance.listAll();
  assertEquals(rows.length, 1);
  // TPOT = (requestFinishedAt - firstOutputTokenAt) * 1000 / (outputTokens - 1).
  // Recorded synchronously at settle entry: tpotUs reflects only the
  // sub-millisecond gap between ctx construction and settle. Fold the
  // 200ms usage write into it (in-band await) and tpotUs would be
  // ~100_000us (200ms / 2). 50_000us fences the regression while
  // tolerating scheduler jitter.
  expect(rows[0].tpotUsSum).toBeLessThan(50_000);
});

test.each(['tokens', 'measurement'])('settle %s keeps start-time prices when a request finishes in another window', async mode => {
  const startedAt = Date.parse('2026-10-16T01:59:59.999Z');
  const timeWindow = { timeZone: 'UTC', weekdays: [5], start: '01:00', end: '02:00' };
  const identity: TelemetryModelIdentity = {
    ...testTelemetryModelIdentity,
    pricing: {
      entries: [
        { rates: { input_tokens: '1', input_cache_read_tokens: '0.1', output_tokens: '3' } },
        { selector: { timeWindow }, rates: { input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '6' } },
      ],
    },
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-10-16T02:00:05Z'));
    for (const requestStartedAt of [startedAt, Date.now()]) {
      const gatewayCtx = { ...ctx(), requestStartedAt };
      if (mode === 'tokens') settle(gatewayCtx, undefined, identity, { input: 10, input_cache_read: 20, output: 5 }, false);
      else settleUsageMeasurement(gatewayCtx, undefined, identity, {
        quantities: { input_tokens: '10', input_cache_read_tokens: '20', output_tokens: '5' }, pricingFacts: {}, dumpTokenUsage: null,
      }, false);
    }
    await Promise.all(background);
    const rows = await repo.usage.listAll();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.hour)).toEqual(['2026-10-16T02', '2026-10-16T02']);
    expect(rows.find(row => row.pricingSelector.timeWindow)?.metrics).toEqual([
      { metric: 'input_tokens', quantity: '10', unitPrice: '2' },
      { metric: 'input_cache_read_tokens', quantity: '20', unitPrice: '0.2' },
      { metric: 'output_tokens', quantity: '5', unitPrice: '6' },
    ]);
    expect(rows.find(row => !row.pricingSelector.timeWindow)?.metrics).toEqual([
      { metric: 'input_tokens', quantity: '10', unitPrice: '1' },
      { metric: 'input_cache_read_tokens', quantity: '20', unitPrice: '0.1' },
      { metric: 'output_tokens', quantity: '5', unitPrice: '3' },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test('calendar outages preserve metered usage with unknown prices and report the original cause', async () => {
  const networkError = new Error('calendar offline');
  initExternalResourceFetcher(async () => { throw networkError; });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // The same hourly bucket already has successfully priced Base usage.
    settle(ctx(), undefined, { ...testTelemetryModelIdentity, pricing: { entries: [{ rates: { input_tokens: '1' } }] } }, { input: 3 }, false);
    await Promise.all(background);
    settle({ ...ctx(), requestStartedAt: Date.parse('2026-10-16T01:00:00Z') }, undefined, {
      ...testTelemetryModelIdentity,
      pricing: {
        entries: [
          { rates: { input_tokens: '1' } },
          { selector: { timeWindow: { timeZone: 'UTC', weekdays: [5], start: '01:00', end: '04:00', excludeHolidays: 'CN' } }, rates: { input_tokens: '2' } },
        ],
      },
    }, { input: 10 }, false);
    await Promise.all(background);
    const rows = await repo.usage.listAll();
    expect(rows).toHaveLength(2);
    const unpriced = rows.find(row => row.pricingSelector.unpriced === 'holiday-calendar-unavailable');
    expect(unpriced?.metrics).toEqual([{ metric: 'input_tokens', quantity: '10', unitPrice: null }]);
    expect(unpriced?.requests).toBe(1);
    expect(rows.find(row => !row.pricingSelector.unpriced)?.metrics).toEqual([{ metric: 'input_tokens', quantity: '3', unitPrice: '1' }]);
    expect(log).toHaveBeenCalledWith('Failed to resolve usage price:', expect.objectContaining({ cause: expect.objectContaining({ cause: networkError }) }));
  } finally {
    log.mockRestore();
  }
});
