import { expect, it } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCodexUpstreamRecord, buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';

it('scopes upstream subscription history to Upstream.Audit and validates query intervals', async () => {
  const { repo, apiKey } = await setupAppTest();
  const headers = { 'x-api-key': apiKey.key };
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'historical', sortOrder: 0 }));
  expect((await requestApp('/api/upstream-metrics?upstream_id=historical&start=0&end=60000&step=60000', { headers })).status).toBe(404);
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'historical' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });
  expect((await requestApp('/api/upstream-metrics?upstream_id=historical&start=0&end=60000&step=60000', { headers })).status).toBe(200);
  await repo.upstreams.delete('historical');
  expect((await requestApp('/api/upstream-metrics?upstream_id=historical&start=0&end=60000&step=60000', { headers })).status).toBe(404);
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'historical', sortOrder: 0 }));
  const user = await repo.users.getById(apiKey.userId);
  await repo.users.save({ ...user!, isAdmin: true });
  expect((await requestApp('/api/upstream-metrics?upstream_id=historical&start=-86400000&end=0&step=60000', { headers })).status).toBe(200);
  expect((await requestApp('/api/upstream-metrics?upstream_id=historical&start=60000&end=0&step=60000', { headers })).status).toBe(400);
  expect((await requestApp('/api/upstream-metrics?upstream_id=historical&start=abc&end=60000&step=60000', { headers })).status).toBe(400);
  for (const step of ['', '&step=0', '&step=-60000', '&step=1.5']) {
    expect((await requestApp(`/api/upstream-metrics?upstream_id=historical&start=0&end=60000${step}`, { headers })).status).toBe(400);
  }
  await repo.upstreamMetrics.record({ upstreamId: 'historical', name: 'quota.remaining', labels: { quota: 'premium_interactions' }, timestamp: 10_000, value: 25 });
  await repo.upstreamMetrics.record({ upstreamId: 'other', name: 'quota.remaining', labels: { quota: 'premium_interactions' }, timestamp: 40_000, value: 50 });
  const response = await requestApp('/api/upstream-metrics?upstream_id=historical&start=0&end=60000&step=60000', { headers });
  expect(response.status).toBe(200);
  expect((await response.clone().json()).records).toHaveLength(1);
  expect(await response.json()).toMatchObject({ start: 0, end: 60_000, step: 60_000, records: [{ upstreamId: 'historical', name: 'quota.remaining', labels: { quota: 'premium_interactions' }, timestamp: 10_000, value: 25 }] });
});

it('discovers provider-owned reset metrics only for auditable upstreams and returns actual cycle boundaries', async () => {
  const { repo, apiKey } = await setupAppTest();
  const headers = { 'x-api-key': apiKey.key };
  await saveUpstreamForTest(repo.upstreams, buildCodexUpstreamRecord({ id: 'cycles' }));
  const url = '/api/upstream-reset-cycles?upstream_id=cycles&end=600000';
  const unavailable = await requestApp(url, { headers });
  expect(unavailable.status).toBe(200);
  expect(await unavailable.json()).toEqual({ upstreamId: 'cycles', available: false, metrics: [] });
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'upstream', upstreamId: 'cycles' }, sortOrder: 0, values: { 'Upstream.Audit': true } });
  const identity = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
  for (const [minute, value] of [[0, 0], [1, 30], [2, 0], [3, 0], [4, 70], [5, 0], [6, 10]] as const) {
    await repo.upstreamMetrics.record({ upstreamId: 'cycles', ...identity, timestamp: minute * 60_000, value });
  }
  await repo.upstreamMetrics.record({ upstreamId: 'cycles', name: 'credits.balance', labels: {}, timestamp: 0, value: 100 });
  const response = await requestApp(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    upstreamId: 'cycles', available: true,
    metrics: [{ identity, display: { name: '', labelKey: 'dashboard.upstreamMetrics.metrics.remaining', windowSeconds: 18_000 }, currentStart: 300_000, previousStart: 120_000 }],
  });
  expect((await requestApp('/api/upstream-reset-cycles?upstream_id=cycles&end=-1', { headers })).status).toBe(400);
  await repo.upstreams.delete('cycles');
  expect((await requestApp(url, { headers })).status).toBe(404);
});
