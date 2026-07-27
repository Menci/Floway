import { test } from 'vitest';

import { truncateUtf8 } from '../../../../../src/data-plane/tools/web-search/providers/truncate.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('truncateUtf8 returns content untouched if under limit', () => {
  assertEquals(truncateUtf8('hello', 100), { content: 'hello', truncated: false, fullContentBytes: 5 });
});

test('truncateUtf8 truncates at exact byte boundary for ASCII', () => {
  assertEquals(truncateUtf8('abcdefghij', 5), { content: 'abcde', truncated: true, fullContentBytes: 10 });
});

test('truncateUtf8 does not split a multi-byte UTF-8 character', () => {
  // '你' is 3 bytes (E4 BD A0). Cap at 2 bytes should yield empty content.
  assertEquals(truncateUtf8('你好', 2), { content: '', truncated: true, fullContentBytes: 6 });
});

test('truncateUtf8 walks back to start of incomplete codepoint', () => {
  // 'a你b' = 61 E4 BD A0 62 (5 bytes). Cap at 3 bytes should give 'a' (1 byte) and discard the incomplete '你'.
  assertEquals(truncateUtf8('a你b', 3), { content: 'a', truncated: true, fullContentBytes: 5 });
});

test('truncateUtf8 keeps a 4-byte codepoint that fits exactly', () => {
  // '🎉' = F0 9F 8E 89 (4 bytes). Cap at 4 -> keep.
  assertEquals(truncateUtf8('🎉', 4), { content: '🎉', truncated: false, fullContentBytes: 4 });
});

test('truncateUtf8 drops a 4-byte codepoint that does not fit', () => {
  assertEquals(truncateUtf8('🎉', 3), { content: '', truncated: true, fullContentBytes: 4 });
});

test('truncateUtf8 handles empty string', () => {
  assertEquals(truncateUtf8('', 100), { content: '', truncated: false, fullContentBytes: 0 });
});
