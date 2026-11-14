import { describe, expect, it, vi } from 'vitest';

import { computeRoundTripTurnDigest, createTurnDigestComputer, createTurnDigestVerifier, verifyRoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

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
    turn.content[0] = 'edited';
    expect(await verify(turn, digest, 1)).toBe(false);
    materialOf.mockClear();
    for (const version of [0, 2]) expect(await verify(turn, digest, version)).toBe(false);
    expect(materialOf).not.toHaveBeenCalled();
  });

  it('preserves synchronous material projection failures in both factory results', () => {
    const failure = new Error('Invalid protocol material');
    const materialOf = (_turn: string): never => { throw failure; };
    const compute = createTurnDigestComputer(materialOf);
    const verify = createTurnDigestVerifier(materialOf);

    expect(() => compute('invalid')).toThrow(failure);
    expect(() => verify('invalid', new Uint8Array(8), 1)).toThrow(failure);
  });
});
