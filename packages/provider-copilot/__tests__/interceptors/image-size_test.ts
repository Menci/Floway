import { test } from 'vitest';

import { targetSizeForResponsesChat } from '../../src/interceptors/image-size.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('gpt-4o / gpt-4.1 use the 2048 box + 768 short edge', () => {
  for (const id of ['gpt-4o', 'gpt-4o-2026', 'gpt-4.1']) {
    assertEquals(targetSizeForResponsesChat(id)({ width: 4096, height: 2048 }), { width: 1536, height: 768 });
  }
});

test('gpt-5-mini clamps the short edge to 768', () => {
  assertEquals(targetSizeForResponsesChat('gpt-5-mini')({ width: 2048, height: 2048 }), { width: 768, height: 768 });
});

test('gemini clamps the long edge to 2048 only', () => {
  assertEquals(targetSizeForResponsesChat('gemini-2.5-pro')({ width: 4000, height: 1000 }), { width: 2048, height: 512 });
});

test('gpt-5.5 and unknown models use the 2048 box + 2.56MP area cap', () => {
  for (const id of ['gpt-5.5', 'gpt-5.4', 'some-future-model']) {
    // 2000x2000 = 4MP -> area cap 2.56MP -> 1600x1600 (long edge 2048 not binding).
    assertEquals(targetSizeForResponsesChat(id)({ width: 2000, height: 2000 }), { width: 1600, height: 1600 });
  }
});

test('a sub-cap screenshot passes through unchanged on gpt-5.5', () => {
  assertEquals(targetSizeForResponsesChat('gpt-5.5')({ width: 1374, height: 1145 }), { width: 1374, height: 1145 });
});
