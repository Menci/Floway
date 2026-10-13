import { describe, expect, it } from 'vitest';

import { hashRoundTripContent, verifyRoundTripReplayCheck } from '../../src/round-trip/replay-check.ts';

describe('round-trip content hashes', () => {
  it.each([
    ['hello', [6, 228, 77, 193, 185, 92, 70, 159]],
    ['\ud800a\udc00?', [255, 13, 52, 82, 149, 33, 105, 132]],
  ])('uses the first eight SHA-256 bytes of UTF-16LE code units for %j', async (text, prefix) => {
    expect(await hashRoundTripContent(text)).toEqual(new Uint8Array(prefix));
  });

  it('verifies exactly eight replay digest bytes', async () => {
    const material = { content: ['answer'] };
    const replayCheck = { version: 1, digest: new Uint8Array([68, 150, 67, 115, 244, 243, 164, 21]) };

    expect(await verifyRoundTripReplayCheck(material, replayCheck)).toBe(true);
    expect(await verifyRoundTripReplayCheck({ content: ['edited'] }, replayCheck)).toBe(false);
    expect(await verifyRoundTripReplayCheck(material, { ...replayCheck, digest: replayCheck.digest.subarray(0, 7) })).toBe(false);
    expect(await verifyRoundTripReplayCheck(material, { ...replayCheck, digest: new Uint8Array([...replayCheck.digest, 0]) })).toBe(false);
  });
});
