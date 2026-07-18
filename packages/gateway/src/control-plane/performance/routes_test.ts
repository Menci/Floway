import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('/api/performance/overview modelRows carry backend-aggregated base-model percentiles', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'claude-opus-4-7',
    upstream: 'copilot:1',
    operation: 'chat' as const,
    runtimeLocation: 'LOCAL',
    tpotUs: 500,
    success: true,
  };

  // 90 fast samples (ttftMs=100 → bucket [0, 100]) + 10 slow samples (ttftMs=300 → bucket [200, 300]).
  // TTFT p50 is local rank 50 of 90; p95 and p99 are local ranks 5 and 9 of
  // 10. Every TPOT sample shares [0, 500], so its local rank is the global rank.
  for (let i = 0; i < 90; i++) {
    await repo.performance.recordSample({ ...sample, ttftMs: 100 });
  }
  for (let i = 0; i < 10; i++) {
    await repo.performance.recordSample({ ...sample, ttftMs: 300 });
  }

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.model, [
    {
      bucket: 'all',
      group: 'claude-opus-4-7',
      requests: 100,
      errors: 0,
      ttftSamples: 100,
      tpotSamples: 100,
      neutral: 0,
      ttftMsP50: 100 * 50 / 91,
      ttftMsP95: 200 + 100 * 5 / 11,
      ttftMsP99: 200 + 100 * 9 / 11,
      tpotUsP50: 500 * 50 / 101,
      tpotUsP95: 500 * 95 / 101,
      tpotUsP99: 500 * 99 / 101,
    },
  ]);
});

test('/api/performance/overview scopes to actor\'s keys in self-by-key mode', async () => {
  const { repo, apiKey } = await setupAppTest();
  // A key owned by user 1 with usage in the same window — must NOT surface to
  // the actor (user 2) under the default self-by-key view.
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const sample = {
    hour: '2026-04-30T10',
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat' as const,
    runtimeLocation: 'LOCAL',
    tpotUs: 500,
    success: true,
  };

  await repo.performance.recordSample({ ...sample, keyId: apiKey.id, ttftMs: 50 });
  await repo.performance.recordSample({ ...sample, keyId: 'key_other', ttftMs: 250 });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.keyId.map((r: { group: string }) => r.group), [apiKey.id]);
  assertEquals(body.dimensionValues.keyIds, [apiKey.id]);
  assertEquals(body.keys.map((key: { id: string }) => key.id), [apiKey.id]);
});

test('/api/performance/overview always returns key metadata', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordSample({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat',
    runtimeLocation: 'LOCAL',
    ttftMs: 50,
    tpotUs: 500,
    success: true,
  });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.keys, [
    {
      id: apiKey.id,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
    },
  ]);
});

test('/api/performance/overview all-by-user view aggregates over every key', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Two users' rows in the same hour. The admin session has
  // canViewGlobalTelemetry=true and defaults to all-by-user; both rows must
  // contribute to the same `model` group.
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
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
  await repo.performance.recordSample({ ...sample, keyId: 'key_other' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&view=all-by-user', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.model.length, 1);
  assertEquals(body.axes.model[0].group, 'gpt-5');
  assertEquals(body.axes.model[0].requests, 2);
});

test('/api/performance/overview rejects all-by-user from a user without canViewGlobalTelemetry', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
});

test('/api/performance/overview keeps API-key data self-scoped in all-by-user view', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_admin',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
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

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user&group_by=keyId', { headers: { 'x-floway-session': adminSession } });

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
  assertEquals(body.axes.model[0].requests, 2);
  assertEquals(body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]).sort(), [['1', 1], ['2', 1]]);
});

test('/api/performance/overview rejects another user\'s API-key filter in all-by-user view', async () => {
  const { adminSession, apiKey } = await setupAppTest();

  const response = await requestApp(`/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user&filter_key_id=${apiKey.id}`, { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 404);
  assertEquals(await response.json(), { error: 'Unknown filter_key_id' });
});

test('/api/performance/overview treats an unknown self-view API-key filter as an empty selection', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&filter_key_id=unknown', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.series, []);
  assertEquals(body.axes.none, []);
});

test('/api/performance/overview all-by-user userRows split rows per user', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
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
  await repo.performance.recordSample({ ...sample, keyId: apiKey.id });
  await repo.performance.recordSample({ ...sample, keyId: 'key_other' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  const groups = body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]).sort();
  assertEquals(groups, [['1', 1], ['2', 2]]);
});

test('/api/performance/overview rejects group_by=userId in self-by-key mode', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&group_by=userId', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, 'group_by=userId is not allowed in self-by-key mode');
});

test('/api/performance/overview series stays per-model under all-by-user view', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
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
  await repo.performance.recordSample({ ...sample, keyId: 'key_other' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&group_by=model&view=all-by-user', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Series stays per-model regardless of view — the page is a latency analysis,
  // and per-user lines have no useful meaning there.
  const seriesGroups = body.series.map((r: { group: string; requests: number }) => [r.group, r.requests]).sort();
  assertEquals(seriesGroups, [['gpt-5', 2]]);
  assertEquals(body.users.map((u: { id: number }) => u.id).sort(), [1, 2]);
  // All-by-user view populates the userIds dropdown; the response drives
  // the admin dashboard's per-user filter.
  assertEquals(body.dimensionValues.userIds.sort((a: number, b: number) => a - b), [1, 2]);
});

test('/api/performance/overview leaves dimensionValues.userIds empty under self-by-key view', async () => {
  const { repo, apiKey } = await setupAppTest();
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

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Self-view rows all belong to the actor; the dashboard hides the user
  // dropdown for this view, and the backend confirms it by never surfacing
  // a single-element list that would encourage a downstream client to
  // render it.
  assertEquals(body.dimensionValues.userIds, []);
});

test('/api/performance/overview returns dashboard aggregates from one repo query', async () => {
  const { repo, apiKey } = await setupAppTest();
  let queryCount = 0;
  const originalQuery = repo.performance.query.bind(repo.performance);
  repo.performance.query = (opts => {
    queryCount++;
    return originalQuery(opts);
  }) as typeof repo.performance.query;

  await repo.performance.recordSample({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'claude-sonnet-4-5',
    upstream: 'copilot:1',
    operation: 'chat',
    runtimeLocation: 'SJC',
    ttftMs: 250,
    tpotUs: 1000,
    success: true,
  });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(queryCount, 1);
  assertEquals(body.series[0].group, 'claude-sonnet-4-5');
  assertEquals(body.axes.none[0].bucket, 'all');
  assertEquals(body.axes.model[0].group, 'claude-sonnet-4-5');
  assertEquals(body.axes.upstream[0].group, 'copilot:1');
  assertEquals(body.axes.runtimeLocation[0].group, 'SJC');
});

test('/api/performance/overview counts failed attempts in dashboard request totals', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordZeroOutputError({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'gpt-5.5-pro-2026-04-23',
    upstream: 'up_copilot',
    operation: 'chat',
    runtimeLocation: 'SJC',
  });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.axes.none[0].requests, 1);
  assertEquals(body.axes.none[0].errors, 1);
  assertEquals(body.axes.none[0].ttftSamples, 0);
  assertEquals(body.axes.model[0].group, 'gpt-5.5-pro-2026-04-23');
  assertEquals(body.axes.model[0].requests, 1);
  assertEquals(body.axes.model[0].errors, 1);
  assertEquals(body.axes.model[0].ttftMsP95, null);
});

test('/api/performance/overview rejects out-of-range timezone offsets', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=day&timezone_offset_minutes=100000000000000000000', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: 'timezone_offset_minutes must be between -1440 and 1440',
  });
});

test('/api/performance/overview rejects non-numeric filter_user_id at the schema boundary', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=abc', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: 'filter_user_id must be a positive integer',
  });
});

test('/api/performance/overview rejects negative filter_user_id', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=-5', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: 'filter_user_id must be a positive integer',
  });
});

test('/api/performance/overview rejects filter_user_id=0 (user ids start at 1)', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=0', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: 'filter_user_id must be a positive integer',
  });
});

test('/api/performance/overview rejects filter_user_id with a leading zero', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=01', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: 'filter_user_id must be a positive integer',
  });
});

test('/api/performance/overview accepts numeric filter_user_id', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&filter_user_id=42', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
});

test('/api/performance/overview all-by-user attributes soft-deleted keys to their original owner', async () => {
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
    '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user',
    { headers: { 'x-floway-session': adminSession } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  const groups = body.axes.userId.map((r: { group: string; requests: number }) => [r.group, r.requests]);
  assertEquals(groups, [[String(apiKey.userId), 1]]);
});

test('/api/performance/overview self-by-key surfaces soft-deleted keys metadata to their owner', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordSample({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: 'copilot:1',
    operation: 'chat',
    runtimeLocation: 'LOCAL',
    ttftMs: 200,
    tpotUs: 500,
    success: true,
  });
  await repo.apiKeys.softDelete(apiKey.id);
  // The acting api key was the one that was soft-deleted; build a fresh
  // active key under the same user so the request authenticates.
  await repo.apiKeys.save({
    id: 'key_fresh',
    userId: apiKey.userId,
    name: 'Fresh',
    key: 'raw_fresh_key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T11:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const response = await requestApp(
    '/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00',
    { headers: { 'x-api-key': 'raw_fresh_key' } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  // The deleted key surfaces in keys[] even though listByUserId active-only
  // would have hidden it; the row attributes back to its keyId in keyRows.
  const ids = body.keys.map((k: { id: string }) => k.id).sort();
  assertEquals(ids.includes(apiKey.id), true);
  const matched = body.axes.keyId.find((r: { group: string }) => r.group === apiKey.id);
  assertEquals(matched?.requests, 1);
});

test('/api/performance/overview returns operationRows grouped by operation value', async () => {
  const { repo, apiKey } = await setupAppTest();

  await repo.performance.recordSample({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'claude-sonnet-4-5',
    upstream: 'copilot:1',
    operation: 'chat',
    runtimeLocation: 'LOCAL',
    ttftMs: 100,
    tpotUs: 500,
    success: true,
  });
  await repo.performance.recordNeutral({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'text-embedding-3-small',
    upstream: 'copilot:1',
    operation: 'embeddings',
    runtimeLocation: 'LOCAL',
  });
  await repo.performance.recordNeutral({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    model: 'text-embedding-3-small',
    upstream: 'copilot:1',
    operation: 'embeddings',
    runtimeLocation: 'LOCAL',
  });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(typeof body.axes.operation, 'object');
  const opGroups = body.axes.operation.map((r: { group: string; requests: number; neutral: number }) => ({ group: r.group, requests: r.requests, neutral: r.neutral })).sort((a: { group: string }, b: { group: string }) => a.group.localeCompare(b.group));
  assertEquals(opGroups, [
    { group: 'chat', requests: 1, neutral: 0 },
    { group: 'embeddings', requests: 2, neutral: 2 },
  ]);
});
