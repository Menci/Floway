import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const seedUsage = async (
  repo: import('../../repo/memory.ts').InMemoryRepo,
  keyId: string,
  hour: string,
  model: string,
  requests: number,
) => {
  await repo.usage.set({
    keyId,
    model,
    upstream: 'up_test',
    modelKey: model,
    hour,
    tier: null,
    requests,
    tokens: { input: 100, output: 50 },
    cost: null,
  });
};

test('/api/token-usage all-by-user attributes soft-deleted keys to their original owner', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  // Token-usage row attributed to apiKey, then soft-delete the key. The
  // by-user aggregator must still resolve the row to apiKey.userId rather
  // than the synthetic userId 0 it falls back to when key→user lookup misses.
  await seedUsage(repo, apiKey.id, '2026-04-30T10', 'gpt-5', 3);
  await repo.apiKeys.softDelete(apiKey.id);

  const response = await requestApp(
    '/api/token-usage?start=2026-04-30T00&end=2026-05-01T00&view=all-by-user',
    { headers: { 'x-floway-session': adminSession } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  // Records is the array. Filter to the row with model gpt-5; userId must be apiKey.userId.
  const rows = body.map((r: { userId: number; model: string; requests: number }) =>
    [r.userId, r.model, r.requests]).sort();
  assertEquals(rows, [[apiKey.userId, 'gpt-5', 3]]);
});

test('/api/token-usage self-by-key surfaces soft-deleted keys metadata to their owner', async () => {
  const { repo, apiKey } = await setupAppTest();
  await seedUsage(repo, apiKey.id, '2026-04-30T10', 'gpt-5', 7);
  await repo.apiKeys.softDelete(apiKey.id);
  // The acting api key was the one that was soft-deleted, so we need a fresh
  // active key under the same user to authenticate the request.
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
    '/api/token-usage?start=2026-04-30T00&end=2026-05-01T00&include_key_metadata=1',
    { headers: { 'x-api-key': 'raw_fresh_key' } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  // The deleted key's name surfaces alongside the row even though listByUserId
  // active-only would have hidden it.
  const matched = body.records.find((r: { keyId: string }) => r.keyId === apiKey.id);
  assertEquals(matched?.keyName, apiKey.name);
});
