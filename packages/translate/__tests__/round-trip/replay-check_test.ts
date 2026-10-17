import { describe, expect, it } from 'vitest';

import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck } from '../../src/round-trip/replay-check.ts';

describe('round-trip replay-check versions', () => {
  it('computes and verifies one selected version and material', async () => {
    const material = { content: ['answer'] };
    const replayCheck = await computeRoundTripReplayCheck(1, material);

    expect(replayCheck.version).toBe(1);
    expect(replayCheck.digest).toEqual(new Uint8Array([68, 150, 67, 115, 244, 243, 164, 21]));
    expect(await verifyRoundTripReplayCheck(material, replayCheck)).toBe(true);
    expect(await verifyRoundTripReplayCheck({ content: ['edited'] }, replayCheck)).toBe(false);
  });

  it('rejects material that JSON cannot serialize', async () => {
    // @ts-expect-error Replay material excludes undefined at the public boundary.
    await expect(computeRoundTripReplayCheck(1, undefined)).rejects.toThrowError('Replay material is not JSON-serializable');
  });
});
