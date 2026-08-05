import { expect, test } from 'vitest';

import { captureExtras } from '../../src/common/reassemble-extras.ts';

test('indexed extension arrays remain dense when an upstream uses a large index', () => {
  const extras: Record<string, unknown> = {};
  captureExtras({ vendor_items: [{ index: 0, text: 'a' }] }, new Set(), extras);
  captureExtras({ vendor_items: [{ index: 1_000_000, text: 'b' }] }, new Set(), extras);

  expect(extras.vendor_items).toEqual([
    { index: 0, text: 'a' },
    { index: 1_000_000, text: 'b' },
  ]);
  expect(extras.vendor_items).toHaveLength(2);
});

test('extension keys cannot mutate the accumulator prototype', () => {
  const extras: Record<string, unknown> = {};
  captureExtras(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>, new Set(), extras);

  expect(Object.getPrototypeOf(extras)).toBe(Object.prototype);
  expect(Object.hasOwn(extras, '__proto__')).toBe(true);
  expect(extras.__proto__).toEqual({ polluted: true });
});
