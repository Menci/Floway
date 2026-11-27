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
    expect(await verify(turn, digest, 3)).toBe(true);
    turn.content[0] = 'edited';
    expect(await verify(turn, digest, 1)).toBe(false);
    expect(await verify(turn, digest, 2)).toBe(false);
    expect(await verify(turn, digest, 3)).toBe(false);
    materialOf.mockClear();
    for (const version of [0, 4]) expect(await verify(turn, digest, version)).toBe(false);
    expect(materialOf).not.toHaveBeenCalled();

    const v1Material = vi.fn((input: { content: string[] }) => ({ v: 1, content: input.content }));
    const v2Material = vi.fn((input: { content: string[] }) => ({ v: 2, content: input.content }));
    const versionedVerify = createTurnDigestVerifier({ 1: v1Material, 2: v2Material, 3: v2Material });
    const v1Digest = await createTurnDigestComputer(v1Material)(turn);
    const v2Digest = await createTurnDigestComputer(v2Material)(turn);
    expect(await versionedVerify(turn, v1Digest, 1)).toBe(true);
    expect(await versionedVerify(turn, v1Digest, 2)).toBe(false);
    expect(await versionedVerify(turn, v2Digest, 2)).toBe(true);
    expect(await versionedVerify(turn, v2Digest, 3)).toBe(true);
    v1Material.mockClear();
    v2Material.mockClear();
    expect(await versionedVerify(turn, v2Digest, 4)).toBe(false);
    expect(v1Material).not.toHaveBeenCalled();
    expect(v2Material).not.toHaveBeenCalled();
  });

});
