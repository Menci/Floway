import { describe, test } from 'vitest';

import { loadTelemetryKeys } from './telemetry-view.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { ApiKey } from '../repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Zero-value ApiKey defaults so a case only names what it exercises.
const stubKey = (overrides: Partial<ApiKey> & Pick<ApiKey, 'id' | 'userId'>): ApiKey => ({
  name: `key ${overrides.id}`,
  key: `raw_${overrides.id}`,
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
  test('self-by-key scopes to the actor\'s keys (own users\' keys stay hidden)', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [
      stubKey({ id: 'key_actor_1', userId: 7 }),
      stubKey({ id: 'key_actor_2', userId: 7 }),
      stubKey({ id: 'key_other', userId: 8 }),
    ]);

    const { keys, keyToUser } = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 7 });

    assertEquals(keys.map(k => k.id).sort(), ['key_actor_1', 'key_actor_2']);
    // The map still resolves the actor's keys back to their user, but never
    // leaks the other user's key id.
    assertEquals([...keyToUser.entries()].sort(), [['key_actor_1', 7], ['key_actor_2', 7]]);
  });

  test('all-by-user returns every key including other users\' rows', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [
      stubKey({ id: 'key_1', userId: 1 }),
      stubKey({ id: 'key_2', userId: 2 }),
    ]);

    const { keys, keyToUser } = await loadTelemetryKeys(repo, { view: 'all-by-user' });

    assertEquals(keys.map(k => k.id).sort(), ['key_1', 'key_2']);
    assertEquals([...keyToUser.entries()].sort(), [['key_1', 1], ['key_2', 2]]);
  });

  test('empty repo returns empty keys and empty map', async () => {
    const repo = new InMemoryRepo();
    const { keys, keyToUser } = await loadTelemetryKeys(repo, { view: 'all-by-user' });
    assertEquals(keys, []);
    assertEquals(keyToUser.size, 0);
  });

  test('single-key single-user roundtrips through both views', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [stubKey({ id: 'key_solo', userId: 5 })]);

    const global = await loadTelemetryKeys(repo, { view: 'all-by-user' });
    assertEquals(global.keys.map(k => k.id), ['key_solo']);
    assertEquals(global.keyToUser.get('key_solo'), 5);

    const scoped = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 5 });
    assertEquals(scoped.keys.map(k => k.id), ['key_solo']);
    assertEquals(scoped.keyToUser.get('key_solo'), 5);

    // A scoped view for a user with no keys collapses to empty.
    const otherScope = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 99 });
    assertEquals(otherScope.keys, []);
    assertEquals(otherScope.keyToUser.size, 0);
  });

  test('soft-deleted keys stay in both scopes so historic telemetry keeps its user attribution', async () => {
    const repo = new InMemoryRepo();
    await seedKeys(repo, [
      stubKey({ id: 'key_live', userId: 3 }),
      stubKey({ id: 'key_gone', userId: 3, deletedAt: '2026-04-01T00:00:00.000Z' }),
    ]);

    const scoped = await loadTelemetryKeys(repo, { view: 'self-by-key', scopeUserId: 3 });
    assertEquals(scoped.keys.map(k => k.id).sort(), ['key_gone', 'key_live']);
    assertEquals(scoped.keyToUser.get('key_gone'), 3);
  });
});
