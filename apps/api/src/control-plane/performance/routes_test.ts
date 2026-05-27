import { test } from 'vitest';

import { latencyBucketForMs } from '../../shared/performance-histogram.ts';
import { assertEquals } from '../../test-assert.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';

test('/api/performance returns backend-aggregated base-model percentiles', async () => {
  const { repo, apiKey } = await setupAppTest();
  const sample = {
    hour: '2026-04-30T10',
    metricScope: 'request_total' as const,
    keyId: apiKey.id,
    upstream: 'copilot:1',
    sourceApi: 'messages' as const,
    targetApi: 'responses' as const,
    stream: true,
    runtimeLocation: 'unknown',
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

test('/api/performance can include key metadata', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.performance.recordLatency({
    hour: '2026-04-30T10',
    metricScope: 'request_total',
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    sourceApi: 'responses',
    targetApi: 'responses',
    stream: false,
    runtimeLocation: 'unknown',
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
    sourceApi: 'messages',
    targetApi: 'responses',
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
    sourceApi: 'responses',
    targetApi: 'responses',
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
