import { test } from 'vitest';

import { fitWithin } from '../src/image-processor.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('fitWithin picks the most restrictive of multiple caps', () => {
  // long-edge cap to 2048 -> 2048x1024; short-edge cap 768 -> 1536x768.
  // Short edge wins.
  assertEquals(
    fitWithin({ width: 4000, height: 2000 }, { maxLongEdge: 2048, maxShortEdge: 768 }),
    { width: 1536, height: 768 },
  );
});
