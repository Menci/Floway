import { test } from 'vitest';

import type { ApiKey } from '../../../src/repo/types.ts';
import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

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

test('/api/token-usage/overview matches the Performance overview shape and filter semantics', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: apiKey.id, model: 'claude', upstream: 'up-b', hour: '2026-04-30T11', requests: 3 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'gpt-5', upstream: 'up-b', hour: '2026-04-30T10', requests: 5 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=model&filter_model=gpt-5&filter_model=claude&filter_upstream=upstream%3Aup-b', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series.map((record: { bucket: string; group: string; requests: number }) => [record.bucket, record.group, record.requests]), [
    ['2026-04-30T10', 'gpt-5', 5],
    ['2026-04-30T11', 'claude', 3],
  ]);
  assertEquals(body.axes.none.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['all', 8]]);
  assertEquals(body.dimensionValues, {
    keyIds: ['key_admin'],
    userIds: [1, 2],
    models: ['claude', 'gpt-5'],
    upstreams: ['upstream:up-a', 'upstream:up-b'],
  });
  assertEquals(body.users.map((user: { id: number; username: string }) => [user.id, user.username]), [[1, 'admin'], [2, 'tester']]);
  assertEquals(body.keys, [{ id: adminKey.id, name: adminKey.name, createdAt: adminKey.createdAt }]);
});

test('/api/token-usage/overview scopes every axis to an administrator under group_by=keyId', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'claude', upstream: null, hour: '2026-04-30T10', requests: 5 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=keyId', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['key_admin', 5]]);
  assertEquals(body.axes.model.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['claude', 5]]);
  assertEquals(body.axes.upstream.map((record: { group: string }) => record.group), ['none']);
  assertEquals(body.dimensionValues.userIds, [1]);
});

test('/api/token-usage/overview preserves hard-deleted key usage under synthetic user 0', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: 'hard-deleted-key', model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 3 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId&filter_user_id=0', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['0', 3]]);
  assertEquals(body.axes.none.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['all', 3]]);
  assertEquals(body.axes.userId.map((record: { group: string; requests: number }) => [record.group, record.requests]), [['0', 3]]);
  assertEquals(body.dimensionValues.userIds, [0]);
  assertEquals(body.dimensionValues.keyIds, []);
  assertEquals(body.users.some((user: { id: number }) => user.id === 0), false);
  assertEquals(body.keys, [{ id: adminKey.id, name: adminKey.name, createdAt: adminKey.createdAt }]);
});

test('/api/token-usage/overview gives a non-admin their User.Audit row and only their key metadata', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'claude', upstream: 'up-b', hour: '2026-04-30T10', requests: 5 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.none[0].requests, 2);
  assertEquals(body.axes.userId.map((row: { group: string; requests: number }) => [row.group, row.requests]), [['2', 2]]);
  assertEquals(body.dimensionValues.userIds, [2]);
  assertEquals(body.users.map((user: { id: number }) => user.id), [2]);
  assertEquals(body.dimensionValues.keyIds, [apiKey.id]);
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
  const body = await response.json();
  assertEquals(body.axes.none[0].requests, 7);
  assertEquals(body.axes.userId.map((row: { group: string; requests: number }) => [row.group, row.requests]), [['1', 5], ['2', 2]]);
  assertEquals(body.dimensionValues.upstreams, ['upstream:up-a', 'upstream:up-b']);
  assertEquals(body.upstreams.map((upstream: { id: string; name: string }) => [upstream.id, upstream.name]), [['up-a', 'A'], ['up-b', 'B']]);
  assertEquals(body.users.map((user: { id: number }) => user.id), [1, 2]);
});

test('/api/token-usage/overview expands Group scopes to current members', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  const group = await repo.groups.create('Admins', 120);
  await repo.groups.replaceMembers(group.id, [1]);
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'group', groupId: group.id },
    sortOrder: 1,
    values: { 'User.Audit': true },
  });
  await seedUsage(repo, { keyId: apiKey.id, model: 'self', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'historical', upstream: 'up-b', hour: '2026-04-30T10', requests: 5 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.userId.map((row: { group: string; requests: number }) => [row.group, row.requests]), [['1', 5], ['2', 2]]);
});

test('/api/token-usage/overview permits user breakdowns while keeping key filters owner-only', async () => {
  const { adminSession, apiKey } = await setupAppTest();
  const userGroup = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId', { headers: { 'x-api-key': apiKey.key } });
  const userFilter = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=1', { headers: { 'x-api-key': apiKey.key } });
  const foreignKey = await requestApp(`/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&filter_key_id=${apiKey.id}`, { headers: { 'x-floway-session': adminSession } });

  assertEquals(userGroup.status, 200);
  assertEquals(userFilter.status, 200);
  assertEquals(foreignKey.status, 404);
  assertEquals(await foreignKey.json(), { error: 'Unknown filter_key_id' });
});

test('/api/token-usage/overview delegates every dashboard axis to one overview read', async () => {
  const { repo, apiKey } = await setupAppTest();
  let queryCount = 0;
  let queryOptions: import('../../../src/repo/types.ts').UsageOverviewQueryOptions | undefined;
  const originalQueryOverview = repo.usage.queryOverview.bind(repo.usage);
  repo.usage.queryOverview = opts => {
    queryCount++;
    queryOptions = opts;
    return originalQueryOverview(opts);
  };
  repo.usage.query = () => Promise.reject(new Error('overview must not hydrate raw Usage records'));
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: null, hour: '2026-04-30T10', requests: 2 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  assertEquals(queryCount, 1);
  assertEquals(queryOptions && {
    actorUserId: queryOptions.actorUserId,
    isAdmin: queryOptions.isAdmin,
    visibleUserIds: queryOptions.visibleUserIds,
    visibleUpstreams: queryOptions.visibleUpstreams,
    start: queryOptions.start,
    end: queryOptions.end,
    groupBy: queryOptions.groupBy,
    filters: queryOptions.filters,
  }, {
    actorUserId: 2,
    isAdmin: false,
    visibleUserIds: [2],
    visibleUpstreams: [],
    start: '2026-04-30T00',
    end: '2026-05-01T00',
    groupBy: 'model',
    filters: { keyIds: [], userIds: [], models: [], upstreams: [] },
  });
});

test('/api/token-usage/overview clips custom calendar buckets without changing totals', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  for (const [hour, requests] of [
    ['2026-04-30T09', 20],
    ['2026-04-30T10', 3],
    ['2026-05-01T02', 5],
    ['2026-05-03T16', 30],
  ] as const) {
    await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour, requests });
  }
  for (const [bucket, expected] of [
    ['week', [['2026-04-27', 8]]],
    ['month', [['2026-04', 3], ['2026-05', 5]]],
    ['2d', [['2026-04-30', 8]]],
    ['2h', [['2026-04-30T18', 3], ['2026-05-01T10', 5]]],
    ['6h', [['2026-04-30T18', 3], ['2026-05-01T06', 5]]],
    ['12h', [['2026-04-30T12', 3], ['2026-05-01T00', 5]]],
  ] as const) {
    const response = await requestApp(`/api/token-usage/overview?start=2026-04-30T10&end=2026-05-03T16&bucket=${bucket}&timezone=Asia%2FSingapore`, { headers: { 'x-floway-session': adminSession } });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.series.map((row: { bucket: string; requests: number }) => [row.bucket, row.requests]), expected);
    assertEquals(body.axes.none[0].requests, 8);
    assertEquals(body.axes.none[0].cost, '16');
  }
});

test('/api/token-usage/overview splits anchored multi-day buckets at local midnight', async () => {
  const { repo, apiKey } = await setupAppTest();
  for (const [hour, requests] of [['2026-05-01T10', 3], ['2026-05-02T15', 5], ['2026-05-02T16', 7]] as const) {
    await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour, requests });
  }
  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T16&end=2026-05-05T16&bucket=2d&timezone=Asia%2FSingapore', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series.map((row: { bucket: string; requests: number; cost: string }) => [row.bucket, row.requests, row.cost]), [['2026-05-01', 8, '16'], ['2026-05-03', 7, '14']]);
  assertEquals(body.axes.none[0].requests, 15);
  assertEquals(body.axes.none[0].cost, '30');
});
