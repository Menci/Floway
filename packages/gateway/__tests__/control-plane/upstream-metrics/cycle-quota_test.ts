import { expect, it } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { upstreamMetricIdentityKey, type UpstreamMetricIdentity } from '@floway-dev/upstream';

const time = (hour: number, minute = 0) => Date.UTC(2026, 10, 18, hour, minute);
const quotaUrl = (upstreamId: string, identity: UpstreamMetricIdentity, cycleStart?: number) => {
  const search = new URLSearchParams({ upstream_id: upstreamId, before: String(time(7)), cycle_metric: upstreamMetricIdentityKey(identity) });
  if (cycleStart !== undefined) search.set('cycle_start', String(cycleStart));
  return `/api/upstream-reset-cycles?${search}`;
};

it('returns the observed reset and its reported allowance for an upstream the operator may audit', async () => {
  const { repo, apiKey, copilotUpstream } = await setupAppTest();
  const upstreamId = copilotUpstream.id;
  const identity = { name: 'quota.remaining', labels: { quota: 'chat' } };
  for (const [timestamp, value, allowance] of [[time(0), 25, 200], [time(1), 200, 200], [time(5), 90, 400]] as const) {
    await repo.upstreamMetrics.record({ upstreamId, ...identity, timestamp, value });
    await repo.upstreamMetrics.record({ upstreamId, ...identity, name: 'quota.entitlement', timestamp, value: allowance });
  }
  const headers = { 'x-api-key': apiKey.key };
  const url = quotaUrl(upstreamId, identity);
  expect(await (await requestApp(url, { headers })).json()).toEqual({ upstreamId, supported: false, metrics: [] });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });
  const response = await requestApp(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ cycle: { start: time(1), end: null, quota: { amount: 200, unit: 'count' } } });
});
