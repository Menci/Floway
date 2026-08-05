import { afterEach, describe, expect, it, vi } from 'vitest';

import { timingSafeEqual } from '../src/timing-safe-equal.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cloudflare timingSafeEqual adapter', () => {
  it('delegates byte comparison to crypto.subtle.timingSafeEqual', () => {
    const primitive = vi.fn(() => true);
    vi.stubGlobal('crypto', { subtle: { timingSafeEqual: primitive } });
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);

    expect(timingSafeEqual(a, b)).toBe(true);
    expect(primitive).toHaveBeenCalledWith(a, b);
  });
});
