import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import { hasRoundTripTarget, type AssistantTurnSidecarCodec } from './codec.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';
import type { ReplayCandidate } from './thin/assistant-turn.ts';
import { hydrateAssistantTurn } from './thin/hydrate.ts';

export interface RoundTripAssistantTurnInspection<Turn> {
  sidecars: string[];
  turn: Turn;
  candidates: ReplayCandidate[];
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
  codec: AssistantTurnSidecarCodec,
  inspect: (turn: SourceTurn) => RoundTripAssistantTurnInspection<SourceTurn>,
  verify: (turn: SourceTurn, replayCheck: RoundTripReplayCheck) => Promise<boolean>,
): Promise<RoundTripAssistantTurn<Target> | undefined> => {
  const inspection = inspect(turn);
  if (inspection.sidecars.length !== 1) return undefined;

  const decoded = await codec.decode(source, inspection.sidecars[0]);
  if (decoded === undefined) return undefined;

  if (!hasRoundTripTarget(decoded, target) || !(await verify(inspection.turn, decoded.replayCheck))) return undefined;

  const hydrated = await hydrateAssistantTurn(
    target,
    inspection.candidates,
    decoded.assistantTurn,
    decoded.referencedContents,
  );
  if (!hydrated.ok) throw new Error(`Authenticated assistant-turn sidecar hydration failed: ${hydrated.reason}`);
  return { turn: hydrated.turn };
};
