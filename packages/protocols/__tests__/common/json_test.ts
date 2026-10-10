import { test } from 'vitest';

import { parseJSONWithRawNumbers } from '../../src/common/json.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('parseJSONWithRawNumbers preserves unsafe integer and non-finite number tokens', () => {
  const source = '{"safe":9007199254740991,"decimal":1.25,"large":900719925474099312345,"overflow":1e999}';
  const value = parseJSONWithRawNumbers(source) as Record<string, unknown>;
  const json = JSON as typeof JSON & { isRawJSON: (value: unknown) => boolean };

  assertEquals(value.safe, 9007199254740991);
  assertEquals(value.decimal, 1.25);
  assert(json.isRawJSON(value.large));
  assert(json.isRawJSON(value.overflow));
  assertEquals(JSON.stringify(value), source);
});
