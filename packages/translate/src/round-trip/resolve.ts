import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import { decodeRoundTripSidecar, hasRoundTripTarget, type AnyRoundTripSidecar } from './sidecar.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';
import type { SidecarCodec } from '../types.ts';

export interface EncodedRoundTripSidecar<Turn> {
  readonly data: string;
  readonly withoutSidecar: () => Turn;
}

export interface RoundTripAssistantTurn<Target extends keyof AssistantTurnByProtocol> {
  turn: AssistantTurnFor<Target>;
}

export const warnDroppedUnrecognizedAssistantReasoning = (
  source: keyof AssistantTurnByProtocol,
  target: keyof AssistantTurnByProtocol,
): void => { console.warn('Dropping reasoning from an unidentifiable foreign assistant turn', { source, target }); };

export const roundTripAssistantTurn = async <Source extends keyof AssistantTurnByProtocol, Target extends keyof AssistantTurnByProtocol, SourceTurn>(
  source: Source,
  target: Target,
  turn: SourceTurn,
  codec: SidecarCodec,
  inspect: (turn: SourceTurn) => EncodedRoundTripSidecar<SourceTurn>[],
  verify: (turn: SourceTurn, sourceTurnDigest: RoundTripTurnDigest, version: number) => Promise<boolean>,
): Promise<RoundTripAssistantTurn<Target> | undefined> => {
  let selected: { candidate: EncodedRoundTripSidecar<SourceTurn>; sidecar: AnyRoundTripSidecar } | undefined;
  for (const candidate of inspect(turn)) {
    const sidecar = await decodeRoundTripSidecar(codec, source, candidate.data);
    if (sidecar === undefined) continue;
    if (selected !== undefined) throw new Error('Assistant turn has multiple recognized round-trip sidecars');
    selected = { candidate, sidecar };
  }
  if (selected === undefined || !hasRoundTripTarget(selected.sidecar, target)
    || !(await verify(selected.candidate.withoutSidecar(), selected.sidecar.sourceTurnDigest, selected.sidecar.v))) return undefined;

  return { turn: selected.sidecar.targetTurn };
};
