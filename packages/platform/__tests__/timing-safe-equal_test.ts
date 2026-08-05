import { describe, expect, it, vi } from 'vitest';

import { initTimingSafeEqual, resetTimingSafeEqualForTesting, timingSafeEqual } from '../src/timing-safe-equal.ts';

describe('timingSafeEqual', () => {
  it('delegates equal-length inputs to the runtime primitive', () => {
    const impl = vi.fn(() => true);
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    initTimingSafeEqual(impl);

    expect(timingSafeEqual(a, b)).toBe(true);
    expect(impl).toHaveBeenCalledWith(a, b);
  });

  it('returns false for unequal lengths without calling the runtime primitive', () => {
    const impl = vi.fn(() => true);
    initTimingSafeEqual(impl);

    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(impl).not.toHaveBeenCalled();
  });

  it('exposes missing runtime initialization for equal and unequal lengths', () => {
    resetTimingSafeEqualForTesting();

    expect(() => timingSafeEqual(new Uint8Array([1]), new Uint8Array([1])))
      .toThrow('TimingSafeEqual not initialized');
    expect(() => timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])))
      .toThrow('TimingSafeEqual not initialized');
  });
});
