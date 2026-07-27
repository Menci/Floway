import { test } from 'vitest';

import { ulid } from '../../src/shared/ulid.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('ulid produces strictly increasing ids within the same millisecond', () => {
  const t = 1_700_000_000_000;
  const a = ulid(t);
  const b = ulid(t);
  const c = ulid(t);
  assertEquals(a < b, true);
  assertEquals(b < c, true);
});

test('ulid produces strictly increasing ids when the clock rewinds', () => {
  // Step forward, then back: the cursor contract requires the rewound call
  // to still sort AFTER the previous max so a paged list never loses rows.
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_699_999_999_000);
  const c = ulid(1_699_999_998_000);
  assertEquals(a < b, true);
  assertEquals(b < c, true);
});
