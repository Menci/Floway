import { expect, it } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { upstreamMetricIdentityKey, type UpstreamMetricIdentity } from '@floway-dev/upstream';

const time = (hour: number, minute = 0) => Date.UTC(2026, 10, 18, hour, minute);
const quotaUrl = (upstreamId: string, identity: UpstreamMetricIdentity, cycleStart?: number) => {
  const search = new URLSearchParams({ upstream_id: upstreamId, before: String(time(7)), cycle_metric: upstreamMetricIdentityKey(identity) });
  if (cycleStart !== undefined) search.set('cycle_start', String(cycleStart));
  return `/api/upstream-reset-cycles?${search}`;
};

it('estimates the requested cycle from its own priced hours, with upstream audit scope', async () => {
  const { repo, apiKey } = await setupAppTest();
  const upstreamId = 'chatgpt-cycles';
  await saveUpstreamForTest(repo.upstreams, buildChatGPTUpstreamRecord({ id: upstreamId }));
  const headers = { 'x-api-key': apiKey.key };
  const metric = { name: 'quota.window.used_percent', labels: { limit: 'premium', window_seconds: 18_000 } };
  const spark = { ...metric, labels: { ...metric.labels, limit: 'spark' } };
  for (const identity of [metric, spark]) {
    for (const [timestamp, value] of [
      [time(0, 45), 75], [time(1, 17), 0], [time(3, 35), 25], [time(6, 5), 80], [time(6, 17), 0], [time(6, 45), 10],
    ] as const) await repo.upstreamMetrics.record({ upstreamId, ...identity, timestamp, value });
  }
  const cost = (clock: number, quantity: string, unitPrice: string | null, upstream = upstreamId) => repo.usage.set({
    keyId: apiKey.id, model: 'model', upstream, modelKey: 'model', hour: new Date(time(clock)).toISOString().slice(0, 13),
    pricingSelector: {}, requests: 1, metrics: [{ metric: 'input_tokens', quantity, unitPrice }],
  });
  await cost(0, '1000', '1');
  await cost(1, '6', '1');
  await cost(3, '4', '1');
  await cost(5, '2000', '1');
  await cost(6, '2', '1');
  await cost(3, '2000', '1', 'another-upstream');

  const historyUrl = `/api/upstream-reset-cycles?upstream_id=${upstreamId}&before=${time(7)}`;
  const url = quotaUrl(upstreamId, metric);
  expect(await (await requestApp(url, { headers })).json()).toEqual({ upstreamId, supported: false, metrics: [] });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });
  const request = async (path: string) => {
    const response = await requestApp(path, { headers });
    expect(response.status).toBe(200);
    return await response.json();
  };
  expect(await request(historyUrl)).toMatchObject({
    upstreamId, supported: true, metrics: expect.arrayContaining([
      expect.objectContaining({ identity: metric, starts: [time(6, 17), time(1, 17)] }),
    ]),
  });
  expect(await request(url)).toMatchObject({ quota: { kind: 'estimated', usd: '20' } });
  expect(await request(quotaUrl(upstreamId, metric, time(1, 17)))).toMatchObject({ quota: { kind: 'estimated', usd: '40' } });
  expect(await request(quotaUrl(upstreamId, metric, time(0)))).not.toHaveProperty('quota');
  expect(await request(quotaUrl(upstreamId, spark))).toMatchObject({ quota: { kind: 'unavailable', reason: 'scope' } });
  await cost(3, '4', null);
  expect(await request(quotaUrl(upstreamId, metric, time(1, 17)))).toMatchObject({ quota: { kind: 'unavailable', reason: 'prices' } });
  await repo.upstreams.delete(upstreamId);
  expect(await request(historyUrl)).toEqual({ upstreamId, supported: false, metrics: [] });
});

it('reports the absolute allowance observed at the selected refill instead of estimating it from spend', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const upstreamId = copilotUpstream.id;
  const identity = { name: 'quota.remaining', labels: { quota: 'chat' } };
  for (const [timestamp, value, allowance] of [[time(0), 25, 200], [time(1), 200, 200], [time(5), 90, 400]] as const) {
    await repo.upstreamMetrics.record({ upstreamId, ...identity, timestamp, value });
    await repo.upstreamMetrics.record({ upstreamId, ...identity, name: 'quota.entitlement', timestamp, value: allowance });
  }
  const headers = { 'x-floway-session': adminSession };
  const response = await requestApp(quotaUrl(upstreamId, identity), { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ quota: { kind: 'reported', amount: 200, unit: 'count' } });
});
