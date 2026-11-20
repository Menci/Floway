import { test } from 'vitest';

import { targetSizeForOpenAIResponsesChat } from '../../src/interceptors/image-size.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('gpt-4o / gpt-4.1 use the 2048 box + 768 short edge', () => {
  for (const id of ['gpt-4o', 'gpt-4.1']) {
    assertEquals(targetSizeForOpenAIResponsesChat(id)({ width: 4096, height: 2048 }), { width: 1536, height: 768 });
  }
});

test('gpt-5.5 and unknown models use the 2048 box + 2.56MP area cap', () => {
  for (const id of ['gpt-5.5', 'some-future-model']) {
    // 2000x2000 = 4MP -> area cap 2.56MP -> 1600x1600 (long edge 2048 not binding).
    assertEquals(targetSizeForOpenAIResponsesChat(id)({ width: 2000, height: 2000 }), { width: 1600, height: 1600 });
  }
});
