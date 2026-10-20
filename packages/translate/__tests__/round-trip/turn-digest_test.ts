import { describe, expect, it } from 'vitest';

import { computeRoundTripTurnDigest, verifyRoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

describe('round-trip turn digests', () => {
  it('computes and verifies replay material', async () => {
    const material = { content: ['answer'] };
    const sourceTurnDigest = await computeRoundTripTurnDigest(material);

    expect(sourceTurnDigest).toEqual(new Uint8Array([68, 150, 67, 115, 244, 243, 164, 21]));
    expect(await verifyRoundTripTurnDigest(material, sourceTurnDigest)).toBe(true);
    expect(await verifyRoundTripTurnDigest({ content: ['edited'] }, sourceTurnDigest)).toBe(false);
  });

  it('rejects material that JSON cannot serialize', async () => {
    // @ts-expect-error Replay material excludes undefined at the public boundary.
    await expect(computeRoundTripTurnDigest(undefined)).rejects.toThrowError('Replay material is not JSON-serializable');
  });
});
