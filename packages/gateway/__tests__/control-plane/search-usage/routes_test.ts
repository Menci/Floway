import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const seedWebSearchUsage = async (repo: import('../../repo/memory.ts').InMemoryRepo, primaryKeyId: string) => {
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  });

  await repo.webSearchUsage.set({ provider: 'tavily', keyId: primaryKeyId, action: 'search', hour: '2026-03-15T10', requests: 2 });
  await repo.webSearchUsage.set({ provider: 'tavily', keyId: primaryKeyId, action: 'fetch_page', hour: '2026-03-15T10', requests: 3 });
  await repo.webSearchUsage.set({ provider: 'microsoft-web-iq', keyId: 'key_other', action: 'search', hour: '2026-03-15T11', requests: 4 });
};

test('/api/search-usage scopes to the actor\'s keys when called with an API key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await seedWebSearchUsage(repo, apiKey.id);

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&view=self-by-key', {
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

test('/api/search-usage all-by-user view aggregates across keys per user', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await seedWebSearchUsage(repo, apiKey.id);

  const response = await requestApp('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user', {
    headers: { 'x-floway-session': adminSession },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Two distinct rows: tavily/user2 (apiKey.userId === 2) and microsoft-web-iq/user1.
  // Aggregation summed both actions for the tavily row. Sort order is hour, userId, provider.
  assertEquals(body, [
    { provider: 'tavily', userId: 2, hour: '2026-03-15T10', requests: 5 },
    { provider: 'microsoft-web-iq', userId: 1, hour: '2026-03-15T11', requests: 4 },
  ]);
});
