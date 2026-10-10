import { expect, it } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';

it('restricts upstream subscription history to administrators and validates query intervals', async () => {
  const { repo, apiKey } = await setupAppTest();
  const headers = { 'x-api-key': apiKey.key };
  expect((await requestApp('/api/upstream-usage?start=0&end=60000', { headers })).status).toBe(403);
  const user = await repo.users.getById(apiKey.userId);
  await repo.users.save({ ...user!, isAdmin: true });
  expect((await requestApp('/api/upstream-usage?start=-86400000&end=0', { headers })).status).toBe(200);
  expect((await requestApp('/api/upstream-usage?start=60000&end=0', { headers })).status).toBe(400);
  expect((await requestApp('/api/upstream-usage?start=abc&end=60000', { headers })).status).toBe(400);
  await repo.upstreamUsageMetrics.record({ upstreamId: 'historical', key: 'premium_interactions', timestamp: 10_000, value: 25 });
  const response = await requestApp('/api/upstream-usage?start=30000&end=60000', { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ start: 30_000, end: 60_000, records: [{ upstreamId: 'historical', timestamp: 10_000, value: 25 }] });
});
