import { expect, test } from 'vitest';

import { mapImageCompressions } from '../../src/interceptors/image-compression.ts';

test('mapImageCompressions preserves order while bounding native encoder concurrency', async () => {
  let active = 0;
  let peak = 0;
  const outputs = await mapImageCompressions(
    Array.from({ length: 17 }, (_, index) => index),
    async input => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return `compressed-${input}`;
    },
  );

  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(outputs).toEqual(Array.from({ length: 17 }, (_, index) => `compressed-${index}`));
});

test('mapImageCompressions drains active work and preserves the first compressor failure', async () => {
  const reason = { kind: 'image encoder failure' };
  let active = 0;
  let finished = 0;

  await expect(mapImageCompressions(
    Array.from({ length: 20 }, (_, index) => index),
    async input => {
      active += 1;
      await Promise.resolve();
      active -= 1;
      finished += 1;
      if (input === 1) throw reason;
      return input;
    },
  )).rejects.toBe(reason);

  expect(active).toBe(0);
  expect(finished).toBeLessThan(20);
});
