import { describe, test } from 'vitest';

import { buildKeyToUserMap } from '../../../src/control-plane/shared/key-to-user.ts';
import type { ApiKey } from '../../../src/repo/types.ts';
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
  responsesRetentionSeconds: 0,
  ...overrides,
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
