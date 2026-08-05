import { test } from 'vitest';

import type { ApiKey } from '../../../src/repo/types.ts';
import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const adminKey: ApiKey = {
  id: 'key_admin',
  userId: 1,
  name: 'Admin key',
  key: 'raw_admin_key',
  serverSecret: '01'.repeat(32),
  createdAt: '2026-04-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
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

test('/api/token-usage/overview limits a non-admin to owned keys and withholds user attribution', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save(adminKey);
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: 'up-a', hour: '2026-04-30T10', requests: 2 });
  await seedUsage(repo, { keyId: adminKey.id, model: 'claude', upstream: 'up-b', hour: '2026-04-30T10', requests: 5 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.none[0].requests, 2);
  assertEquals(body.axes.userId, []);
  assertEquals(body.dimensionValues.userIds, []);
  assertEquals(body.users, []);
  assertEquals(body.dimensionValues.keyIds, [apiKey.id]);
});

test('/api/token-usage/overview enforces identity filter authorization', async () => {
  const { adminSession, apiKey } = await setupAppTest();
  const userGroup = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId', { headers: { 'x-api-key': apiKey.key } });
  const userFilter = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=1', { headers: { 'x-api-key': apiKey.key } });
  const foreignKey = await requestApp(`/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00&filter_key_id=${apiKey.id}`, { headers: { 'x-floway-session': adminSession } });

  assertEquals(userGroup.status, 403);
  assertEquals(await userGroup.json(), { error: 'group_by=userId requires administrator privileges' });
  assertEquals(userFilter.status, 403);
  assertEquals(await userFilter.json(), { error: 'filter_user_id requires administrator privileges' });
  assertEquals(foreignKey.status, 404);
  assertEquals(await foreignKey.json(), { error: 'Unknown filter_key_id' });
});

test('/api/token-usage/overview reads Usage records once for every dashboard axis', async () => {
  const { repo, apiKey } = await setupAppTest();
  let queryCount = 0;
  const originalQuery = repo.usage.query.bind(repo.usage);
  repo.usage.query = opts => {
    queryCount++;
    return originalQuery(opts);
  };
  await seedUsage(repo, { keyId: apiKey.id, model: 'gpt-5', upstream: null, hour: '2026-04-30T10', requests: 2 });

  const response = await requestApp('/api/token-usage/overview?start=2026-04-30T00&end=2026-05-01T00', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  assertEquals(queryCount, 1);
});
