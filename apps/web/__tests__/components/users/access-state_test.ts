import { describe, expect, test } from 'vitest';

import type { ControlPlaneUser } from '../../../src/api/types';
import { batchUpstreamAccessStates, updateBatchUpstreamAccessChanges } from '../../../src/components/users/access-state';

const user = (id: number, upstreamIds: string[] | null): ControlPlaneUser => ({
  id,
  username: `user-${id}`,
  isAdmin: false,
  upstreamIds,
  createdAt: '2026-08-19T00:00:00.000Z',
});

describe('batch user upstream access state', () => {
  test('distinguishes unanimous and mixed access without creating changes', () => {
    const states = batchUpstreamAccessStates([
      user(1, null),
      user(2, ['up_all', 'up_mixed']),
      user(3, ['up_all']),
    ], ['up_all', 'up_mixed', 'up_none']);

    expect([...states]).toEqual([
      ['up_all', true],
      ['up_mixed', 'mixed'],
      ['up_none', 'mixed'],
    ]);
  });

  test('records only explicit changes and drops a unanimous change restored to its initial value', () => {
    const initial = new Map<string, boolean | 'mixed'>([
      ['up_allowed', true],
      ['up_mixed', 'mixed'],
    ]);
    const denied = updateBatchUpstreamAccessChanges(initial, new Map(), 'up_allowed', false);
    expect([...denied]).toEqual([['up_allowed', false]]);
    expect([...updateBatchUpstreamAccessChanges(initial, denied, 'up_allowed', true)]).toEqual([]);
    expect([...updateBatchUpstreamAccessChanges(initial, new Map(), 'up_mixed', true)]).toEqual([['up_mixed', true]]);
  });
});
