import { describe, expect, it } from 'vitest';

import { timingSafeEqual } from '../src/timing-safe-equal.ts';

describe('Node timingSafeEqual adapter', () => {
  it('delegates byte comparison to node:crypto', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
});
