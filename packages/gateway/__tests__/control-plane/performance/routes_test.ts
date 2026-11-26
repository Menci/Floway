import { test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('/api/performance/overview keeps only the none axis global for a non-admin', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'copilot:1', name: 'Self visible' }));
  await repo.apiKeys.save({
    id: 'key_admin_owned',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  });

  const sample = {
    hour: '2026-04-30T10',
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat' as const,
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  };
  await repo.performance.recordSample({ ...sample, keyId: apiKey.id });
  await repo.performance.recordSample({ ...sample, keyId: 'key_admin_owned' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.none[0].requests, 2);
  // Resource and user breakdowns remain scoped to visible cells.
  assertEquals(body.axes.model.length, 1);
  assertEquals(body.axes.model[0].requests, 1);
  assertEquals(body.axes.userId.map((row: { group: string; requests: number }) => [row.group, row.requests]), [['2', 1]]);
  assertEquals(body.users.map((user: { id: number }) => user.id), [2]);
  assertEquals(body.dimensionValues.userIds, [2]);
  assertEquals(body.upstreams, [{ id: 'copilot:1', name: 'Self visible', hue: 210 }]);

  const useSlice = (query: string) => requestApp(
    `/api/performance/overview?format=buckets&start=2026-04-30T00&end=2026-05-01T00&bucket=day&${query}`,
    { headers: { 'x-api-key': apiKey.key } },
  );
  const sliced = await useSlice('group_by=model');
  assertEquals(sliced.status, 200);
  const slices = await sliced.json();
  assertEquals(slices.globalSummary.requests, 2);
  assertEquals(slices.globalSummary.buckets, undefined);
  assertEquals(slices.buckets[0].rows[0].requests, 1);
  assertEquals(slices.buckets[0].total, undefined);
  const ranking = await useSlice('group_by=model&dimension=keyId');
  const rank = await ranking.json();
  assertEquals(rank.globalSummary, undefined);
  assertEquals(rank.buckets[0].rows.map((row: { group: string }) => row.group), [apiKey.id]);
  const continued = await useSlice('group_by=model&cursor=2026-04-30T11');
  const delta = await continued.json();
  assertEquals(delta.start, '2026-04-30T11');
  assertEquals(delta.reset, false);
  assertEquals(delta.buckets, []);
  assertEquals(delta.globalSummary.requests, 2);
});

test('/api/performance/overview narrows an administrator to their own keys under group_by=keyId too', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_admin',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  });

  const sample = {
    hour: '2026-04-30T10',
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat' as const,
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  };
  await repo.performance.recordSample({ ...sample, keyId: apiKey.id });
  await repo.performance.recordSample({ ...sample, keyId: 'key_admin' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=keyId', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series.map((r: { group: string }) => r.group), ['key_admin']);
  assertEquals(body.axes.keyId.map((r: { group: string }) => r.group), ['key_admin']);
  assertEquals(body.dimensionValues.keyIds, ['key_admin']);
  assertEquals(body.keys, [{
    id: 'key_admin',
    name: 'Admin owned',
    createdAt: '2026-04-30T00:00:00.000Z',
  }]);
  // By API Key means "my data" for administrators as well: the other user's
  // row is out of scope, so every cross-cutting axis counts one request.
  assertEquals(body.axes.model[0].requests, 1);
  assertEquals(body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]), [['1', 1]]);
});

test('/api/performance/overview attributes soft-deleted keys to their original owner', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Latency sample on apiKey, then soft-delete the key. The aggregator must
  // still resolve the row to apiKey.userId rather than the synthetic userId 0
  // it falls back to when the key→user lookup misses.
  await repo.performance.recordSample({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat',
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  });
  await repo.apiKeys.softDelete(apiKey.id);

  const response = await requestApp(
    '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00',
    { headers: { 'x-floway-session': adminSession } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  const groups = body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]);
  assertEquals(groups, [[String(apiKey.userId), 1]]);
});

test('/api/performance/overview merges calendar bucket histograms before calculating percentiles', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    keyId: apiKey.id, model: 'gpt-5', upstream: 'copilot:1', operation: 'chat' as const,
    runtimeLocation: 'LOCAL', tpotUs: 500, success: true,
  };
  for (let index = 0; index < 90; index++) await repo.performance.recordSample({ ...sample, hour: '2026-04-30T10', ttftMs: 100 });
  for (let index = 0; index < 10; index++) await repo.performance.recordSample({ ...sample, hour: '2026-05-01T02', ttftMs: 300 });
  for (const hour of ['2026-04-30T09', '2026-05-03T16']) await repo.performance.recordSample({ ...sample, hour, ttftMs: 10_000 });

  for (const [bucket, key] of [['week', '2026-04-27'], ['2d', '2026-04-30']] as const) {
    const response = await requestApp(`/api/performance/overview?start=2026-04-30T10&end=2026-05-03T16&bucket=${bucket}&timezone=Asia%2FSingapore`, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.series.length, 1);
    assertEquals(body.series[0].bucket, key);
    assertEquals(body.series[0].requests, 100);
    assertEquals(body.series[0].ttftMsP95, 200 + 100 * 5 / 11);
  }
});

test('telemetry overviews reject invalid or reversed custom timestamps', async () => {
  const { apiKey } = await setupAppTest();
  for (const endpoint of ['performance', 'token-usage']) {
    for (const query of [
      'start=2026-04-31T00&end=2026-05-02T00',
      'start=2026-05-02T00&end=2026-05-01T00',
      'start=2026-05-01T00&end=2026-05-02T00&bucket=0d',
    ]) {
      const response = await requestApp(`/api/${endpoint}/overview?${query}`, { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 400);
    }
  }
});
