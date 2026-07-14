import { expect, test } from 'vitest';

import { takeRequestBody } from './request-body.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('takeRequestBody transfers bytes and clears the source owner', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const source = { bytes, streamError: 'partial upload' };

  const owned = takeRequestBody(source);

  expect(owned.bytes).toBe(bytes);
  assertEquals(owned.streamError, 'partial upload');
  assertEquals(source.bytes.byteLength, 0);
});
