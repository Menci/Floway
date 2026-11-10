import { describe, expect, it } from 'vitest';

import { hashRoundTripContent, verifyRoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

describe('round-trip content hashes', () => {
  it.each([
    ['hello', [6, 228, 77, 193, 185, 92, 70, 159]],
    ['\ud800a\udc00?', [255, 13, 52, 82, 149, 33, 105, 132]],
  ])('uses the first eight SHA-256 bytes of UTF-16LE code units for %j', async (text, prefix) => {
    expect(await hashRoundTripContent(text)).toEqual(new Uint8Array(prefix));
  });

  it('verifies exactly eight replay digest bytes', async () => {
    const material = { content: ['answer'] };
    const sourceTurnDigest = new Uint8Array([68, 150, 67, 115, 244, 243, 164, 21]);

    expect(await verifyRoundTripTurnDigest(material, sourceTurnDigest)).toBe(true);
    expect(await verifyRoundTripTurnDigest({ content: ['edited'] }, sourceTurnDigest)).toBe(false);
    expect(await verifyRoundTripTurnDigest(material, sourceTurnDigest.subarray(0, 7))).toBe(false);
    expect(await verifyRoundTripTurnDigest(material, new Uint8Array([...sourceTurnDigest, 0]))).toBe(false);
  });
});
