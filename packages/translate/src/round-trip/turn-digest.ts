import type { IRJSONObject, IRJSONValue } from '../ir/common/json.ts';

export type RoundTripTurnDigest = Uint8Array;

export const replayMaterialsByType = <Material extends IRJSONObject & { readonly type: string }>(materials: readonly Material[]): [string, Material[]][] => {
  const groups = new Map<string, Material[]>();
  for (const material of materials) {
    const group = groups.get(material.type) ?? [];
    group.push(material);
    groups.set(material.type, group);
  }
  return [...groups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
};

const stringifyReplayMaterial = (material: IRJSONValue): string => {
  const text = JSON.stringify(material);
  if (text === undefined) throw new TypeError('Replay material is not JSON-serializable');
  return text;
};

const utf16Bytes = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), true);
  return bytes;
};

export const hashRoundTripContent = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', utf16Bytes(text)), 0, 8);

export const computeRoundTripTurnDigest = async (material: IRJSONValue): Promise<RoundTripTurnDigest> =>
  await hashRoundTripContent(stringifyReplayMaterial(material));

export const verifyRoundTripTurnDigest = async (material: IRJSONValue, sourceTurnDigest: RoundTripTurnDigest): Promise<boolean> => {
  const digest = await hashRoundTripContent(stringifyReplayMaterial(material));
  return digest.length === sourceTurnDigest.length && digest.every((byte, index) => byte === sourceTurnDigest[index]);
};

/**
 * The digest a source computes over one assistant turn, at its current version.
 *
 * Every protocol hashes its own material; only the version switch is the same,
 * so this holds the switch and the caller supplies the material.
 */
export const createTurnDigestComputer = <Turn>(
  materialOf: (turn: Turn) => IRJSONValue,
): (turn: Turn) => Promise<RoundTripTurnDigest> => async turn => await computeRoundTripTurnDigest(materialOf(turn));

/** The verifier half of {@link createTurnDigestComputer}. */
export const createTurnDigestVerifier = <Turn>(
  materialOf: (turn: Turn) => IRJSONValue,
): (turn: Turn, sourceTurnDigest: RoundTripTurnDigest, version: number) => Promise<boolean> => (turn, sourceTurnDigest, version) => {
  switch (version) {
  case 1: return verifyRoundTripTurnDigest(materialOf(turn), sourceTurnDigest);
  default: return Promise.resolve(false);
  }
};
