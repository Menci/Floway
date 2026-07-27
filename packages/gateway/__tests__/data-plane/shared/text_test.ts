import { test } from 'vitest';

import { truncatePreservingCodePoints } from '../../../src/data-plane/shared/text.ts';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

test('truncatePreservingCodePoints: empty string is a no-op', () => {
  assertEquals(truncatePreservingCodePoints('', 512), '');
});

test('truncatePreservingCodePoints: string of exactly `max` length is unchanged (no ellipsis injected)', () => {
  const s = 'a'.repeat(512);
  assertEquals(truncatePreservingCodePoints(s, 512), s);
});

test('truncatePreservingCodePoints: high surrogate at position max-1 walks back to drop the orphan', () => {
  // U+1F600 (grinning face) is a surrogate pair: high D83D + low DE00.
  // Place the high surrogate at index max-1 (= 9) so a naive
  // slice(0, max) would retain the orphan high surrogate. The helper
  // must walk back one code unit and slice at max-1 (= 9), producing
  // a 9-char string with no orphan.
  const prefix = 'a'.repeat(9); // chars 0..8
  const emoji = '😀'; // chars 9..10 → high at 9, low at 10
  const suffix = 'b';
  const input = prefix + emoji + suffix; // length 12
  const out = truncatePreservingCodePoints(input, 10);
  assertEquals(out.length, 9);
  assertEquals(out, prefix);
  // Sanity: no orphan high surrogate in the output.
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    assertFalse(code >= 0xD800 && code <= 0xDBFF);
  }
});
