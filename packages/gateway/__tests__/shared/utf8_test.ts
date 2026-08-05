import { test } from 'vitest';

import { utf8ByteLength } from '../../src/shared/utf8.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('utf8ByteLength matches TextEncoder without allocating the encoded payload', () => {
  for (const value of ['', 'ascii', '响应', '😀', '\ud800', '\udfff', 'a\ud800😀\udfffz']) {
    assertEquals(utf8ByteLength(value), new TextEncoder().encode(value).byteLength, JSON.stringify(value));
  }
});
