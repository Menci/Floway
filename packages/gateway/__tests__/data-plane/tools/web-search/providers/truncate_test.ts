import { test } from 'vitest';

import { truncateUtf8 } from '../../../../../src/data-plane/tools/web-search/providers/truncate.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('truncateUtf8 walks back to start of incomplete codepoint', () => {
  // 'a你b' = 61 E4 BD A0 62 (5 bytes). Cap at 3 bytes should give 'a' (1 byte) and discard the incomplete '你'.
  assertEquals(truncateUtf8('a你b', 3), { content: 'a', truncated: true, fullContentBytes: 5 });
});
