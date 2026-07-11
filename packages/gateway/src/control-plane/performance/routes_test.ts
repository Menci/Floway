import { test } from 'vitest';

import { latencyBucketForMs } from '../../shared/performance-histogram.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('/api/performance returns backend-aggregated base-model percentiles', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    hour: '2026-04-30T10',
    metricScope: 'request_total' as const,
    keyId: apiKey.id,
    upstream: 'copilot:1',
    stream: true,
    runtimeLocation: 'LOCAL',
  };

  for (let i = 0; i < 90; i++) {
    await repo.performance.recordLatency({
      ...sample,
      model: 'claude-opus-4-7',
      modelKey: 'claude-opus-4.7',
      durationMs: 100,
    });
  }
  for (let i = 0; i < 10; i++) {
    await repo.performance.recordLatency({
      ...sample,
      model: 'claude-opus-4-7',
      modelKey: 'claude-opus-4.7-xhigh',
      durationMs: 300,
    });
  }

  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&group_by=model&metric_scope=request_total', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  const slowBucket = latencyBucketForMs(300).upperMs;
  assertEquals(body.records, [
    {
      bucket: '2026-04-30T10',
      group: 'claude-opus-4-7',
      requests: 100,
      errors: 0,
      totalMsSum: 12000,
      avgMs: 120,
      p50Ms: 100,
      p95Ms: slowBucket,
      p99Ms: slowBucket,
    },
  ]);
});

test('/api/performance scopes to actor\'s keys in self-by-key mode', async () => {
  const { repo, apiKey } = await setupAppTest();
  // A key owned by user 1 with usage in the same window — must NOT surface to
  // the actor (user 2) under the default self-by-key view.
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const sample = {
    hour: '2026-04-30T10',
    metricScope: 'request_total' as const,
    upstream: null,
    stream: false,
    runtimeLocation: 'LOCAL',
  };

  await repo.performance.recordLatency({ ...sample, keyId: apiKey.id, model: 'gpt-5', modelKey: 'gpt-5', durationMs: 50 });
  await repo.performance.recordLatency({ ...sample, keyId: 'key_other', model: 'gpt-5', modelKey: 'gpt-5', durationMs: 250 });

  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&group_by=keyId', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Only the actor's key surfaces; the other user's row is filtered out.
  assertEquals(body.records.length, 1);
  assertEquals(body.records[0].group, apiKey.id);
});

test('/api/performance can include key metadata', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordLatency({
    hour: '2026-04-30T10',
    metricScope: 'request_total',
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    stream: false,
    runtimeLocation: 'LOCAL',
    durationMs: 50,
  });

  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&include_key_metadata=1', { headers: { 'x-api-key': apiKey.key } });

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

test('/api/performance all-by-user view aggregates over every key', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Two users' rows in the same hour. The admin session has
  // canViewGlobalTelemetry=true and defaults to all-by-user; both rows must
  // contribute to the same `model` group.
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const sample = {
    hour: '2026-04-30T10',
    metricScope: 'request_total' as const,
    model: 'gpt-5',
    modelKey: 'gpt-5',
    upstream: null,
    stream: false,
    runtimeLocation: 'LOCAL',
    durationMs: 100,
  };
  await repo.performance.recordLatency({ ...sample, keyId: apiKey.id });
  await repo.performance.recordLatency({ ...sample, keyId: 'key_other' });

  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&group_by=model&view=all-by-user', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.records.length, 1);
  assertEquals(body.records[0].group, 'gpt-5');
  assertEquals(body.records[0].requests, 2);
});

test('/api/performance rejects all-by-user from a user without canViewGlobalTelemetry', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
});

test('/api/performance rejects group_by=keyId in all-by-user mode', async () => {
  const { adminSession } = await setupAppTest();
  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user&group_by=keyId', { headers: { 'x-floway-session': adminSession } });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, 'group_by=keyId is not allowed in all-by-user mode');
});

test('/api/performance all-by-user view supports group_by=userId', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Admin owned',
    key: 'raw_admin_owned',
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const sample = {
    hour: '2026-04-30T10',
    metricScope: 'request_total' as const,
    model: 'gpt-5',
    modelKey: 'gpt-5',
    upstream: null,
    stream: false,
    runtimeLocation: 'LOCAL',
    durationMs: 100,
  };
  await repo.performance.recordLatency({ ...sample, keyId: apiKey.id });
  await repo.performance.recordLatency({ ...sample, keyId: apiKey.id });
  await repo.performance.recordLatency({ ...sample, keyId: 'key_other' });

  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&group_by=userId&view=all-by-user', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  const groups = body.records.map((r: { group: string; requests: number }) => [r.group, r.requests]).sort();
  assertEquals(groups, [['1', 1], ['2', 2]]);
});

test('/api/performance rejects group_by=userId in self-by-key mode', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&group_by=userId', { headers: { 'x-api-key': apiKey.key } });
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
    createdAt: '2026-04-30T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const sample = {
    hour: '2026-04-30T10',
    metricScope: 'request_total' as const,
    model: 'gpt-5',
    modelKey: 'gpt-5',
    upstream: null,
    stream: false,
    runtimeLocation: 'LOCAL',
    durationMs: 100,
  };
  await repo.performance.recordLatency({ ...sample, keyId: apiKey.id });
  await repo.performance.recordLatency({ ...sample, keyId: 'key_other' });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&metric_scope=request_total&view=all-by-user&include_user_metadata=1', { headers: { 'x-floway-session': adminSession } });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Series stays per-model regardless of view — the page is a latency analysis,
  // and per-user lines have no useful meaning there.
  const seriesGroups = body.series.map((r: { group: string; requests: number }) => [r.group, r.requests]).sort();
  assertEquals(seriesGroups, [['gpt-5', 2]]);
  assertEquals(body.users.map((u: { id: number }) => u.id).sort(), [1, 2]);
});

test('/api/performance/overview returns dashboard aggregates from one repo query', async () => {
  const { repo, apiKey } = await setupAppTest();
  let queryCount = 0;
  const originalQuery = repo.performance.query.bind(repo.performance);
  repo.performance.query = (opts => {
    queryCount++;
    return originalQuery(opts);
  }) as typeof repo.performance.query;

  await repo.performance.recordLatency({
    hour: '2026-04-30T10',
    metricScope: 'request_total',
    keyId: apiKey.id,
    model: 'claude-sonnet-4-5',
    upstream: 'copilot:1',
    modelKey: 'claude-sonnet-4.5-xhigh',
    stream: true,
    runtimeLocation: 'SJC',
    durationMs: 250,
  });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&metric_scope=request_total', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(queryCount, 1);
  assertEquals(body.series[0].group, 'claude-sonnet-4-5');
  assertEquals('percentileSeries' in body, false);
  assertEquals(body.summaryRows[0].bucket, 'all');
  assertEquals(body.modelRows[0].group, 'claude-sonnet-4-5');
  assertEquals(body.runtimeRows[0].group, 'SJC');
});

test('/api/performance/overview counts failed attempts in dashboard request totals', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordError({
    hour: '2026-04-30T10',
    metricScope: 'request_total',
    keyId: apiKey.id,
    model: 'gpt-5.5-pro-2026-04-23',
    upstream: 'up_copilot',
    modelKey: 'gpt-5.5-pro-2026-04-23',
    stream: true,
    runtimeLocation: 'SJC',
  });

  const response = await requestApp('/api/performance/overview?start=2026-04-30T00&end=2026-05-01T00&bucket=hour&metric_scope=request_total', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.summaryRows[0].requests, 1);
  assertEquals(body.summaryRows[0].errors, 1);
  assertEquals(body.summaryRows[0].avgMs, null);
  assertEquals(body.modelRows[0].group, 'gpt-5.5-pro-2026-04-23');
  assertEquals(body.modelRows[0].requests, 1);
  assertEquals(body.modelRows[0].errors, 1);
  assertEquals(body.modelRows[0].p95Ms, null);
});

test('/api/performance rejects out-of-range timezone offsets', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/performance?start=2026-04-30T00&end=2026-05-01T00&bucket=day&timezone_offset_minutes=100000000000000000000', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: 'timezone_offset_minutes must be between -1440 and 1440',
  });
});

test('/api/performance all-by-user attributes soft-deleted keys to their original owner', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Latency sample on apiKey, then soft-delete the key. The aggregator must
  // still resolve the row to apiKey.userId rather than the synthetic userId 0
  // it falls back to when the key→user lookup misses.
  await repo.performance.recordLatency({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    metricScope: 'request_total',
    model: 'gpt-5',
    modelKey: 'gpt-5',
    upstream: null,
    stream: false,
    runtimeLocation: 'LOCAL',
    durationMs: 100,
  });
  await repo.apiKeys.softDelete(apiKey.id);

  const response = await requestApp(
    '/api/performance?start=2026-04-30T00&end=2026-05-01T00&group_by=userId&view=all-by-user',
    { headers: { 'x-floway-session': adminSession } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  const groups = body.records.map((r: { group: string; requests: number }) => [r.group, r.requests]);
  assertEquals(groups, [[String(apiKey.userId), 1]]);
});

test('/api/performance self-by-key surfaces soft-deleted keys metadata to their owner', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordLatency({
    hour: '2026-04-30T10',
    keyId: apiKey.id,
    metricScope: 'request_total',
    model: 'gpt-5',
    modelKey: 'gpt-5',
    upstream: null,
    stream: false,
    runtimeLocation: 'LOCAL',
    durationMs: 200,
  });
  await repo.apiKeys.softDelete(apiKey.id);
  // The acting api key was the one that was soft-deleted; build a fresh
  // active key under the same user so the request authenticates.
  await repo.apiKeys.save({
    id: 'key_fresh',
    userId: apiKey.userId,
    name: 'Fresh',
    key: 'raw_fresh_key',
    createdAt: '2026-04-30T11:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  const response = await requestApp(
    '/api/performance?start=2026-04-30T00&end=2026-05-01T00&group_by=keyId&include_key_metadata=1',
    { headers: { 'x-api-key': 'raw_fresh_key' } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  // The deleted key surfaces in keys[] even though listByUserId active-only
  // would have hidden it; the row attributes back to its keyId.
  const ids = body.keys.map((k: { id: string }) => k.id).sort();
  assertEquals(ids.includes(apiKey.id), true);
  const matched = body.records.find((r: { group: string }) => r.group === apiKey.id);
  assertEquals(matched?.requests, 1);
});
