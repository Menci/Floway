import { afterEach, expect, test, vi } from 'vitest';

import type { TokenUsageOverviewResponse } from '../../../src/control-plane/usage-types.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const adminKey: ApiKey = {
  id: 'key_admin',
  userId: 1,
  name: 'Admin key',
  key: 'raw_admin_key',
  serverSecret: '01'.repeat(32),
  createdAt: '2026-04-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
};

const seedUsage = async (
  repo: import('../../repo/memory.ts').InMemoryRepo,
  { keyId, model, upstream, hour, requests }: { keyId: string; model: string; upstream: string | null; hour: string; requests: number },
) => {
  await repo.usage.set({
    keyId,
    model,
    upstream,
    modelKey: model,
    hour,
    pricingSelector: {},
    requests,
    metrics: tokenUsageMetrics({ input: requests * 10, output: requests * 5 }, { input_tokens: '0.1', output_tokens: '0.2' }),
  });
};

test('/api/token-usage/overview returns filtered axes and authorized facets per bucket', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: apiKey.id, model: 'claude', upstream: 'up-b', hour: '2026-04-30T11', requests: 3 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'gpt-5', upstream: 'up-b', hour: '2026-04-30T10', requests: 5 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=model&filter_model=gpt-5&filter_model=claude&filter_upstream=upstream%3Aup-b', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json() as TokenUsageOverviewResponse;
  assertEquals(body.buckets.flatMap(bucket => bucket.axes.model.map(record => [bucket.bucket, record.group, record.requests])), [
    ['2026-04-30T10', 'gpt-5', 5],
    ['2026-04-30T11', 'claude', 3],
  ]);
  assertEquals(body.buckets[0]!.dimensionValues, {
    keyIds: ['key_admin'],
    userIds: [1, 2],
    models: ['gpt-5'],
    upstreams: ['upstream:up-a', 'upstream:up-b'],
  });
  assertEquals(body.users.map((user: { id: number; username: string }) => [user.id, user.username]), [[1, 'admin'], [2, 'tester']]);
  assertEquals(body.keys, [{ id: adminKey.id, name: adminKey.name, createdAt: adminKey.createdAt }]);
});

test('/api/token-usage/overview preserves hard-deleted key usage under synthetic user 0', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: 'hard-deleted-key', model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 3 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId&filter_user_id=0', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json() as TokenUsageOverviewResponse;
  assertEquals(body.buckets[0]!.axes.none.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['all', 3]]);
  assertEquals(body.buckets[0]!.axes.userId.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['0', 3]]);
  assertEquals(body.buckets[0]!.dimensionValues.userIds, [0]);
  assertEquals(body.buckets[0]!.dimensionValues.keyIds, []);
  assertEquals(body.users.some((user: { id: number }) => user.id === 0), false);
  assertEquals(body.keys, [{ id: adminKey.id, name: adminKey.name, createdAt: adminKey.createdAt }]);
});

test('/api/token-usage/overview shows the union of visible user rows and upstream columns', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up-a', name: 'A' }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up-b', name: 'B' }));
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up-b' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });
  await seedUsage(repo, { keyId: apiKey.id, model: 'self', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'visible-column', upstream: 'up-b', hour: '2026-04-30T10', requests: 5 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'hidden', upstream: 'up-c', hour: '2026-04-30T10', requests: 7 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as TokenUsageOverviewResponse;
  assertEquals(body.buckets[0]!.axes.none[0]?.requests, 7);
  assertEquals(body.buckets[0]!.axes.userId.map((row: { group: string; requests: number }) => [row.group, row.requests]), [['1', 5], ['2', 2]]);
  assertEquals(body.buckets[0]!.dimensionValues.upstreams, ['upstream:up-a', 'upstream:up-b']);
  assertEquals(body.upstreams.map((upstream: { id: string; name: string }) => [upstream.id, upstream.name]), [['up-a', 'A'], ['up-b', 'B']]);
  assertEquals(body.users.map((user: { id: number }) => user.id), [1, 2]);
});

test('a cursor resumes one hour before the previous read and splits only the boundary buckets', async () => {
  vi.setSystemTime(new Date('2026-04-30T14:20:00Z'));
  const { repo, adminSession, apiKey } = await setupAppTest();
  const query = vi.spyOn(repo.usage, 'queryOverview');
  const read = async (cursor?: string) => {
    const params = new URLSearchParams({ start: '2026-04-01T00', end: '2026-05-04T00', bucket: 'day' });
    if (cursor) params.set('cursor', cursor);
    const response = await requestApp(`/api/token-usage/overview?${params}`, { headers: { 'x-floway-session': adminSession } });
    expect(response.status).toBe(200);
    return await response.json() as TokenUsageOverviewResponse;
  };
  const seed = (hour: string, requests = 1) => seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: null, hour, requests });
  for (const hour of ['2026-04-01T00', '2026-04-30T12', '2026-04-30T13', '2026-04-30T14', '2026-05-03T00']) await seed(hour);
  const initial = await read();
  expect(initial.reset).toBe(true);
  expect(initial.cursor).toBe('2026-04-30T13');
  expect(initial.buckets.map(bucket => bucket.start)).toEqual(['2026-04-01T00', '2026-04-30T12', '2026-04-30T13', '2026-04-30T14']);
  expect(initial.end).toBe('2026-04-30T15');

  vi.setSystemTime(new Date('2026-05-02T09:10:00Z'));
  await seed('2026-04-30T13', 3);
  for (const hour of ['2026-04-30T23', '2026-05-01T04', '2026-05-01T16', '2026-05-02T00', '2026-05-02T09']) await seed(hour);
  const delta = await read(initial.cursor);
  expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ start: '2026-04-30T13', end: '2026-05-02T10' }));
  expect(delta).toMatchObject({ reset: false, start: '2026-04-30T13', end: '2026-05-02T10' });
  expect(delta.buckets.map(bucket => [bucket.start, bucket.end, bucket.axes.none[0]?.requests])).toEqual([
    ['2026-04-30T13', '2026-04-30T14', 3],
    ['2026-04-30T14', '2026-04-30T15', 1],
    ['2026-04-30T23', '2026-05-01T00', 1],
    ['2026-05-01T04', '2026-05-01T17', 2],
    ['2026-05-02T00', '2026-05-02T01', 1],
    ['2026-05-02T09', '2026-05-02T10', 1],
  ]);
  expect((await read(delta.cursor)).start).toBe('2026-05-02T08');
});

test('an empty historical overview does not evaluate out-of-window bucket labels', async () => {
  const { adminSession } = await setupAppTest();
  const response = await requestApp('/api/token-usage/overview?start=0000-01-01T00&end=0000-01-02T00&bucket=2d&timezone_offset_minutes=60', {
    headers: { 'x-floway-session': adminSession },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ buckets: [], cursor: '0000-01-02T00' });
});
