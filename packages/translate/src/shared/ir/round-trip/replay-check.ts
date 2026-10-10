import { hashIRContent } from '../iat.ts';
import type { IRRoundTripReplayCheck } from './types.ts';

export const createIRRoundTripReplayCheck = async (checkMaterial: unknown, version: number): Promise<IRRoundTripReplayCheck> => ({
  version,
  digest: await hashIRContent(JSON.stringify(checkMaterial) as string),
});

export const verifyIRRoundTripReplayCheck = async (checkMaterial: unknown, replayCheck: IRRoundTripReplayCheck, version: number): Promise<boolean> => {
  if (replayCheck.version !== version) return false;
  const digest = await hashIRContent(JSON.stringify(checkMaterial) as string);
  return digest.length === replayCheck.digest.length && digest.every((byte, index) => byte === replayCheck.digest[index]);
};
