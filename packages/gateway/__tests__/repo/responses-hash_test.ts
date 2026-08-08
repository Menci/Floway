import { expect, test } from 'vitest';

import { hashResponsesJson } from '../../src/repo/responses-hash.ts';
import { sha256Hex } from '@floway-dev/platform';

const legacySortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(legacySortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, legacySortJson(entry)]),
  );
};

const legacyHash = async (value: unknown): Promise<string> =>
  await sha256Hex(new TextEncoder().encode(JSON.stringify(legacySortJson(value))));

test.each([
  { z: 1, a: 2, omitted: undefined, nested: { second: true, first: null } },
  { array: [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1e21, 1e20] },
  { unicode: '中文😀\ud800', escaped: '\b\f\n\r\t"\\' },
  { input: Array.from({ length: 4 }, (_, index) => ({ index, image_url: `data:image/png;base64,${'A'.repeat(1024 * 1024)}` })) },
])('preserves the stored canonical Responses digest', async value => {
  expect(await hashResponsesJson(value)).toBe(await legacyHash(value));
});
