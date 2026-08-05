import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('timingSafeEqual', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('delegates equal-length inputs to the runtime primitive', async () => {
    const { initTimingSafeEqual, timingSafeEqual } = await import('../src/timing-safe-equal.ts');
    const impl = vi.fn(() => true);
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    initTimingSafeEqual(impl);

    expect(timingSafeEqual(a, b)).toBe(true);
    expect(impl).toHaveBeenCalledWith(a, b);
  });

  it('returns false for unequal lengths without calling the runtime primitive', async () => {
    const { initTimingSafeEqual, timingSafeEqual } = await import('../src/timing-safe-equal.ts');
    const impl = vi.fn(() => true);
    initTimingSafeEqual(impl);

    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(impl).not.toHaveBeenCalled();
  });

  it('exposes missing runtime initialization for equal and unequal lengths', async () => {
    const { timingSafeEqual, timingSafeEqualVariableLength } = await import('../src/timing-safe-equal.ts');

    expect(() => timingSafeEqual(new Uint8Array([1]), new Uint8Array([1])))
      .toThrow('TimingSafeEqual not initialized');
    expect(() => timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])))
      .toThrow('TimingSafeEqual not initialized');
    await expect(timingSafeEqualVariableLength(new Uint8Array([1]), new Uint8Array([1, 2])))
      .rejects.toThrow('TimingSafeEqual not initialized');
  });

  it('hashes variable-length secrets to a fixed width before comparing them', async () => {
    const { initTimingSafeEqual, timingSafeEqualVariableLength } = await import('../src/timing-safe-equal.ts');
    const impl = vi.fn((a: Uint8Array, b: Uint8Array) =>
      a.every((value, index) => value === b[index]));
    initTimingSafeEqual(impl);

    await expect(timingSafeEqualVariableLength(
      new TextEncoder().encode('same secret'),
      new TextEncoder().encode('same secret'),
    )).resolves.toBe(true);
    await expect(timingSafeEqualVariableLength(
      new TextEncoder().encode('short'),
      new TextEncoder().encode('a different and longer secret'),
    )).resolves.toBe(false);

    expect(impl).toHaveBeenCalledTimes(2);
    for (const [a, b] of impl.mock.calls) {
      expect(a).toHaveLength(32);
      expect(b).toHaveLength(32);
    }
  });
});
