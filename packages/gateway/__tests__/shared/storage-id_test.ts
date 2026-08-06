import { test } from 'vitest';

import { isStorageId } from '../../src/shared/storage-id.ts';
import { assertEquals } from '@floway-dev/test-utils';

test.each([
  ['', false],
  ['nul\0id', false],
  ['high\uD800', false],
  ['low\uDC00', false],
  ['reversed\uDC00\uD800', false],
  ['plain-id', true],
  ['paired-\uD83D\uDE00', true],
] as const)('isStorageId(%#) returns %s', (value, expected) => {
  assertEquals(isStorageId(value), expected);
});
