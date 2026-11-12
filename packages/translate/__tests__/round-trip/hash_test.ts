import { describe, expect, it } from 'vitest';

import { hashRoundTripContent } from '../../src/round-trip/hash.ts';

describe('round-trip content hashes', () => {
  it.each([
    ['hello', [6, 228, 77, 193, 185, 92, 70, 159]],
    ['\ud800a\udc00?', [255, 13, 52, 82, 149, 33, 105, 132]],
  ])('uses the first eight SHA-256 bytes of UTF-16LE code units for %j', async (text, prefix) => {
    expect(await hashRoundTripContent(text)).toEqual(new Uint8Array(prefix));
  });
});
