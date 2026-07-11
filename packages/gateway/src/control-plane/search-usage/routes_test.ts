import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const seedSearchUsage = async (repo: import('../../repo/memory.ts').InMemoryRepo, primaryKeyId: string) => {
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });

  await repo.searchUsage.set({ provider: 'tavily', keyId: primaryKeyId, action: 'search', hour: '2026-03-15T10', requests: 2 });
  await repo.searchUsage.set({ provider: 'tavily', keyId: primaryKeyId, action: 'fetch_page', hour: '2026-03-15T10', requests: 3 });
  await repo.searchUsage.set({ provider: 'microsoft-grounding', keyId: 'key_other', action: 'search', hour: '2026-03-15T11', requests: 4 });
};

test('/api/search-usage scopes to the actor\'s keys when called with an API key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await seedSearchUsage(repo, apiKey.id);

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Non-admin actor sees only their own key's rows; the other user's row is excluded.
  assertEquals(body, [
    {
      provider: 'tavily',
      keyId: apiKey.id,
      hour: '2026-03-15T10',
      requests: 5,
    },
  ]);
});

test('/api/search-usage in self-by-key mode includes per-key metadata for the actor only', async () => {
  const { repo, apiKey } = await setupAppTest();
  await seedSearchUsage(repo, apiKey.id);
  await repo.searchConfig.save({
    provider: 'microsoft-grounding',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
    jina: { apiKey: '' },
  });

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&include_key_metadata=1', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.activeProvider, 'microsoft-grounding');
  assertEquals(body.keys, [
    { id: apiKey.id, name: apiKey.name, createdAt: apiKey.createdAt },
  ]);
  assertEquals(body.records, [
    {
      provider: 'tavily',
      keyId: apiKey.id,
      hour: '2026-03-15T10',
      requests: 5,
      keyName: apiKey.name,
      keyCreatedAt: apiKey.createdAt,
    },
  ]);
});

test('/api/search-usage all-by-user view aggregates across keys per user', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await seedSearchUsage(repo, apiKey.id);

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user', {
    headers: { 'x-floway-session': adminSession },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Two distinct rows: tavily/user2 (apiKey.userId === 2) and microsoft-grounding/user1.
  // Aggregation summed both actions for the tavily row. Sort order is hour, userId, provider.
  assertEquals(body, [
    { provider: 'tavily', userId: 2, hour: '2026-03-15T10', requests: 5 },
    { provider: 'microsoft-grounding', userId: 1, hour: '2026-03-15T11', requests: 4 },
  ]);
});

test('/api/search-usage all-by-user view with include_user_metadata=1 includes user listing', async () => {
  const { adminSession } = await setupAppTest();

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user&include_user_metadata=1', {
    headers: { 'x-floway-session': adminSession },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(Array.isArray(body.records), true);
  assertEquals(Array.isArray(body.users), true);
  assertEquals(body.users.length >= 2, true);
  // Both seed users surface in the metadata listing.
  assertEquals(body.users.find((u: { id: number }) => u.id === 1).username, 'admin');
  assertEquals(body.users.find((u: { id: number }) => u.id === 2).username, 'tester');
});

test('/api/search-usage rejects all-by-user from a user without canViewGlobalTelemetry', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user', {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 403);
});

test('/api/search-usage filters by provider and rejects invalid provider', async () => {
  const { repo, apiKey } = await setupAppTest();
  await seedSearchUsage(repo, apiKey.id);

  const filtered = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&provider=tavily', {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(filtered.status, 200);
  assertEquals(await filtered.json(), [
    { provider: 'tavily', keyId: apiKey.id, hour: '2026-03-15T10', requests: 5 },
  ]);

  const invalid = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&provider=disabled', {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(invalid.status, 400);
});

test('/api/search-usage requires start and end', async () => {
  const { apiKey } = await setupAppTest();

  const missingStart = await requestApp('/api/search-usage?end=2026-03-16T00', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(missingStart.status, 400);
  assertEquals(await missingStart.json(), { error: 'start and end query parameters are required (e.g. 2026-03-09T00)' });

  const missingEnd = await requestApp('/api/search-usage?start=2026-03-15T00', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(missingEnd.status, 400);
  assertEquals(await missingEnd.json(), { error: 'start and end query parameters are required (e.g. 2026-03-09T00)' });
});

test('/api/search-usage all-by-user attributes soft-deleted keys to their original owner', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Seed a usage row, then soft-delete the originating key. The aggregator
  // must still resolve the row to apiKey.userId — not the synthetic userId 0
  // it falls back to when the key→user lookup misses.
  await repo.searchUsage.set({ provider: 'tavily', keyId: apiKey.id, action: 'search', hour: '2026-03-15T10', requests: 7 });
  await repo.apiKeys.softDelete(apiKey.id);

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user', {
    headers: { 'x-floway-session': adminSession },
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), [
    { provider: 'tavily', userId: apiKey.userId, hour: '2026-03-15T10', requests: 7 },
  ]);
});
