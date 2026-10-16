import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import { decodeRoundTripSidecar, hasRoundTripTarget } from './sidecar.ts';
import type { TranslateSidecarCodec } from '../types.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';

export interface RoundTripAssistantTurnInspection<Turn> {
  sidecar?: string;
  turn: Turn;
}

export interface RoundTripAssistantTurn<Target extends keyof AssistantTurnByProtocol> {
  turn: AssistantTurnFor<Target>;
}

export const warnDroppedForeignAssistantReasoning = (
  source: keyof AssistantTurnByProtocol,
  target: keyof AssistantTurnByProtocol,
): void => { console.warn('Dropping reasoning from an unidentifiable foreign assistant turn', { source, target }); };

export const roundTripAssistantTurn = async <Source extends keyof AssistantTurnByProtocol, Target extends keyof AssistantTurnByProtocol, SourceTurn>(
  source: Source,
  target: Target,
  turn: SourceTurn,
  codec: TranslateSidecarCodec,
  inspect: (turn: SourceTurn) => RoundTripAssistantTurnInspection<SourceTurn>,
  verify: (turn: SourceTurn, replayCheck: RoundTripReplayCheck) => Promise<boolean>,
): Promise<RoundTripAssistantTurn<Target> | undefined> => {
  const inspection = inspect(turn);
  if (inspection.sidecar === undefined) return undefined;

  const decoded = await decodeRoundTripSidecar(codec, source, inspection.sidecar);
  if (decoded === undefined) return undefined;

  if (!hasRoundTripTarget(decoded, target) || !(await verify(inspection.turn, decoded.replayCheck))) return undefined;

  return { turn: decoded.assistantTurn };
};
