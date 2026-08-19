import { describe, expect, test } from 'vitest';

import { applyUserUpstreamAccessChanges } from '../../../src/control-plane/users/upstream-access.ts';

describe('applyUserUpstreamAccessChanges', () => {
  test('keeps unrestricted users unrestricted when every change grants access', () => {
    expect(applyUserUpstreamAccessChanges(null, ['up_a', 'up_b'], [
      { upstreamId: 'up_b', allowed: true },
    ])).toBeNull();
  });

  test('turns a denial on an unrestricted user into the remaining catalog whitelist', () => {
    expect(applyUserUpstreamAccessChanges(null, ['up_a', 'up_b', 'up_c'], [
      { upstreamId: 'up_b', allowed: false },
    ])).toEqual(['up_a', 'up_c']);
  });

  test('preserves untouched membership and order while applying grants and denials', () => {
    expect(applyUserUpstreamAccessChanges(['up_c', 'up_a', 'up_stale'], ['up_a', 'up_b', 'up_c'], [
      { upstreamId: 'up_a', allowed: false },
      { upstreamId: 'up_b', allowed: true },
    ])).toEqual(['up_c', 'up_stale', 'up_b']);
  });

  test('represents denying the final upstream as an empty whitelist', () => {
    expect(applyUserUpstreamAccessChanges(null, ['up_a'], [
      { upstreamId: 'up_a', allowed: false },
    ])).toEqual([]);
  });
});
