import { describe, expect, it, vi } from 'vitest';

import { createTurnDigestComputer, createTurnDigestVerifier, verifyRoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

describe('round-trip turn digests', () => {

  it('verifies exactly eight replay digest bytes', async () => {
    const material = { content: ['answer'] };
    const sourceTurnDigest = new Uint8Array([68, 150, 67, 115, 244, 243, 164, 21]);

    expect(await verifyRoundTripTurnDigest(material, sourceTurnDigest)).toBe(true);
    expect(await verifyRoundTripTurnDigest({ content: ['edited'] }, sourceTurnDigest)).toBe(false);
    expect(await verifyRoundTripTurnDigest(material, sourceTurnDigest.subarray(0, 7))).toBe(false);
    expect(await verifyRoundTripTurnDigest(material, new Uint8Array([...sourceTurnDigest, 0]))).toBe(false);
  });

  it('projects each current turn and skips material evaluation for unsupported versions', async () => {
    const materialOf = vi.fn((turn: { content: string[] }) => ({ content: turn.content }));
    const compute = createTurnDigestComputer(materialOf);
    const verify = createTurnDigestVerifier(materialOf);
    const turn = { content: ['answer'] };
    const digest = await compute(turn);

    expect(digest).toEqual(new Uint8Array([68, 150, 67, 115, 244, 243, 164, 21]));
    expect(await verify(turn, digest, 1)).toBe(true);
    expect(await verify(turn, digest, 2)).toBe(true);
    turn.content[0] = 'edited';
    expect(await verify(turn, digest, 1)).toBe(false);
    expect(await verify(turn, digest, 2)).toBe(false);
    materialOf.mockClear();
    for (const version of [0, 3]) expect(await verify(turn, digest, version)).toBe(false);
    expect(materialOf).not.toHaveBeenCalled();

    const versionedVerify = createTurnDigestVerifier({ 1: materialOf });
    expect(await versionedVerify(turn, await compute(turn), 1)).toBe(true);
    materialOf.mockClear();
    expect(await versionedVerify(turn, digest, 2)).toBe(false);
    expect(materialOf).not.toHaveBeenCalled();
  });

});
