import { describe, test } from 'vitest';

import { buildKeyToUserMap, loadTelemetryKeys } from './telemetry-view.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { ApiKey } from '../repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Zero-value ApiKey defaults so a case only names what it exercises.
const stubKey = (overrides: Partial<ApiKey> & Pick<ApiKey, 'id' | 'userId'>): ApiKey => ({
  name: `key ${overrides.id}`,
  key: `raw_${overrides.id}`,
  serverSecret: '00'.repeat(32),
  createdAt: '2026-04-30T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  ...overrides,
});

const seedKeys = async (repo: InMemoryRepo, keys: readonly ApiKey[]): Promise<void> => {
  for (const k of keys) await repo.apiKeys.save(k);
};

describe('loadTelemetryKeys', () => {
  test('self-by-key scopes to the actor\'s keys (other users\' keys stay hidden)', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [
      stubKey({ id: 'key_actor_1', userId: 7 }),
      stubKey({ id: 'key_actor_2', userId: 7 }),
      stubKey({ id: 'key_other', userId: 8 }),
    ]);

    const keys = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 7 });

    assertEquals(keys.map(k => k.id).sort(), ['key_actor_1', 'key_actor_2']);
  });

  test('all-by-user returns every key including other users\' rows', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [
      stubKey({ id: 'key_1', userId: 1 }),
      stubKey({ id: 'key_2', userId: 2 }),
    ]);

    const keys = await loadTelemetryKeys(repo, { view: 'all-by-user' });

    assertEquals(keys.map(k => k.id).sort(), ['key_1', 'key_2']);
  });

  test('empty repo returns empty keys', async () => {
    const repo = new InMemoryRepo();
    const keys = await loadTelemetryKeys(repo, { view: 'all-by-user' });
    assertEquals(keys, []);
  });

  test('single-key single-user roundtrips through both views', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [stubKey({ id: 'key_solo', userId: 5 })]);

    const global = await loadTelemetryKeys(repo, { view: 'all-by-user' });
    assertEquals(global.map(k => k.id), ['key_solo']);

    const scoped = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 5 });
    assertEquals(scoped.map(k => k.id), ['key_solo']);

    // A scoped view for a user with no keys collapses to empty.
    const otherScope = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 99 });
    assertEquals(otherScope, []);
  });

  test('soft-deleted keys stay in both scopes so historic telemetry keeps its user attribution', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [
      stubKey({ id: 'key_live', userId: 3 }),
      stubKey({ id: 'key_gone', userId: 3, deletedAt: '2026-04-01T00:00:00.000Z' }),
    ]);

    const scoped = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 3 });
    assertEquals(scoped.map(k => k.id).sort(), ['key_gone', 'key_live']);
  });
});

describe('buildKeyToUserMap', () => {
  test('maps every key back to its owning user', () => {
    const keys: ApiKey[] = [
      stubKey({ id: 'key_a', userId: 1 }),
      stubKey({ id: 'key_b', userId: 2 }),
      stubKey({ id: 'key_c', userId: 1, deletedAt: '2026-04-01T00:00:00.000Z' }),
    ];
    const map = buildKeyToUserMap(keys);
    assertEquals([...map.entries()].sort(), [['key_a', 1], ['key_b', 2], ['key_c', 1]]);
  });

  test('empty input yields an empty map', () => {
    assertEquals(buildKeyToUserMap([]).size, 0);
  });
});
