import { test } from 'vitest';

import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const displayQuantity = (record: { metrics: Array<{ metric: string; quantity: string }> }, tokenCategory: string) =>
  record.metrics.find(row => row.metric === `${tokenCategory}_tokens`)?.quantity;

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
    pricingSelector: {},
    requests,
    metrics: tokenUsageMetrics({ input: 100, output: 50 }, null),
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
    serverSecret: '00'.repeat(32),
    createdAt: '2026-04-30T11:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 0,
  });

  const response = await requestApp(
    '/api/token-usage?start=2026-04-30T00&end=2026-05-01T00&include_key_metadata=1&view=self-by-key',
    { headers: { 'x-api-key': 'raw_fresh_key' } },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.view, 'self-by-key');
  // The deleted key's name surfaces alongside the row even though listByUserId
  // active-only would have hidden it.
  const matched = body.records.find((r: { keyId: string }) => r.keyId === apiKey.id);
  assertEquals(matched?.keyName, apiKey.name);
});

test('/api/token-usage scopes to the actor\'s keys when called with an API key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 0,
  });
  await repo.usage.set({
    keyId: apiKey.id,
    model: 'claude-sonnet-4',
    upstream: null,
    modelKey: 'claude-sonnet-4',
    hour: '2026-03-15T10',
    pricingSelector: {},
    requests: 2,
    metrics: tokenUsageMetrics({ input: 10, output: 5, input_cache_read: 4, input_cache_write: 1 }, null),
  });
  await repo.usage.set({
    keyId: 'key_other',
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-15T11',
    pricingSelector: {},
    requests: 1,
    metrics: tokenUsageMetrics({ input: 20, output: 8, input_cache_read: 6, input_cache_write: 2 }, null),
  });

  const response = await requestApp('/api/token-usage?start=2026-03-15T00&end=2026-03-16T00&view=self-by-key', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Non-admin actor sees only their own key's rows; the other user's row is excluded.
  assertEquals(body.length, 1);
  assertEquals(body[0].keyId, apiKey.id);
  assertEquals(body[0].keyName, 'Primary key');
  assertEquals(displayQuantity(body[0], 'input_cache_read'), '4');
  assertEquals(displayQuantity(body[0], 'input_cache_write'), '1');
});

test('/api/token-usage in self-by-key mode includes per-key metadata for the actor only', async () => {
  const { repo, apiKey } = await setupAppTest();
  // Add a second key under the same user; they should both surface.
  await repo.apiKeys.save({
    id: 'key_actor_secondary',
    userId: apiKey.userId,
    name: 'Actor secondary',
    key: 'raw_actor_secondary',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-03-16T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 0,
  });
  await repo.usage.set({
    keyId: 'key_actor_secondary',
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-16T10',
    pricingSelector: {},
    requests: 1,
    metrics: tokenUsageMetrics({ input: 20, output: 8 }, null),
  });

  const response = await requestApp('/api/token-usage?start=2026-03-16T00&end=2026-03-17T00&include_key_metadata=1&view=self-by-key', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.records.length, 1);
  assertEquals(body.records[0].keyId, 'key_actor_secondary');
  assertEquals(body.keys, [
    { id: apiKey.id, name: apiKey.name, createdAt: apiKey.createdAt },
    { id: 'key_actor_secondary', name: 'Actor secondary', createdAt: '2026-03-16T00:00:00.000Z' },
  ]);
});

test('/api/token-usage all-by-user view aggregates across keys per user', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.usage.set({
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-15T10',
    pricingSelector: {},
    requests: 1,
    metrics: tokenUsageMetrics({ input: 10, output: 5 }, null),
  });

  const response = await requestApp(
    '/api/token-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user',
    { headers: { 'x-floway-session': adminSession } },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 1);
  assertEquals(body[0].userId, apiKey.userId);
  assertEquals(displayQuantity(body[0], 'input'), '10');
});

test('/api/token-usage rejects all-by-user from a non-admin user', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp(
    '/api/token-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user',
    { headers: { 'x-api-key': apiKey.key } },
  );
  assertEquals(response.status, 403);
});

test('/api/token-usage merges Claude variants into backend base model records', async () => {
  const { repo, apiKey } = await setupAppTest();
  const shared = {
    keyId: apiKey.id,
    hour: '2026-03-17T10',
    upstream: 'copilot:1',
    pricingSelector: {},
    requests: 1,
    metrics: tokenUsageMetrics({ input: 10, output: 5, input_cache_read: 2, input_cache_write: 1 }, null),
  };

  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7',
  });
  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7-xhigh',
  });
  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7-1m-internal',
  });
  await repo.usage.set({
    ...shared,
    model: 'gpt-5.3-codex',
    modelKey: 'gpt-5.3-codex',
    metrics: tokenUsageMetrics({ input: 3, output: 4 }, null),
  });

  const response = await requestApp('/api/token-usage?start=2026-03-17T00&end=2026-03-18T00&view=self-by-key', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 2);
  const opus = body.find((record: { model: string }) => record.model === 'claude-opus-4-7');
  const gpt = body.find((record: { model: string }) => record.model === 'gpt-5.3-codex');
  assertExists(opus);
  assertExists(gpt);
  assertEquals(opus.requests, 3);
  assertEquals(displayQuantity(opus, 'input'), '30');
  assertEquals(displayQuantity(opus, 'output'), '15');
  assertEquals(displayQuantity(opus, 'input_cache_read'), '6');
  assertEquals(displayQuantity(opus, 'input_cache_write'), '3');
});
