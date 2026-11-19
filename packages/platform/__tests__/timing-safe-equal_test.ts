import { expect, it, vi } from 'vitest';

import { initTimingSafeEqual, timingSafeEqual } from '../src/timing-safe-equal.ts';

it('timingSafeEqual returns false for unequal lengths without calling the runtime primitive', () => {
  const impl = vi.fn(() => true);
  initTimingSafeEqual(impl);

  expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  expect(impl).not.toHaveBeenCalled();
});
