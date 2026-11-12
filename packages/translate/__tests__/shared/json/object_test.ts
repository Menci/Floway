import { expect, test } from 'vitest';

import { parseJSONObject } from '../../../src/shared/json/object.ts';

test('default object parsing preserves number tokens that would serialize differently', () => {
  const source = '{"rounded":0.10000000000000001,"negativeZero":-0,"canonical":1.25}';

  expect(JSON.stringify(parseJSONObject(source))).toBe(source);
});
