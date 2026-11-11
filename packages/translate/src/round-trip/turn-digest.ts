import { hashRoundTripContent } from './hash.ts';
import type { IRJSONObject, IRJSONValue } from '../ir/types.ts';

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

export const computeRoundTripTurnDigest = async (material: IRJSONValue): Promise<RoundTripTurnDigest> =>
  await hashRoundTripContent(stringifyReplayMaterial(material));

export const verifyRoundTripTurnDigest = async (material: IRJSONValue, sourceTurnDigest: RoundTripTurnDigest): Promise<boolean> => {
  const digest = await hashRoundTripContent(stringifyReplayMaterial(material));
  return digest.length === sourceTurnDigest.length && digest.every((byte, index) => byte === sourceTurnDigest[index]);
};
