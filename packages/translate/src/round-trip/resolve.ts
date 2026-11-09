import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import { decodeRoundTripSidecar, hasRoundTripTarget, type AnyRoundTripSidecar } from './sidecar.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';
import type { SidecarCodec } from '../types.ts';
import type { ReplayContent } from './reference/assistant-turn.ts';
import { restoreAssistantTurn } from './reference/restore.ts';

export interface EncodedRoundTripSidecar<Turn> {
  readonly data: string;
  readonly withoutSidecar: () => Turn;
}


/**
 * A turn a sidecar restored, and the calls it leaves waiting for answers.
 *
 * A source that correlates an id-less tool result against the calls it has seen
 * would otherwise miss these: the restored turn never passed through the
 * reader, so nothing registered its calls. The ids are the target's own — they
 * are what a later result has to name — so they can only be read once the turn
 * exists.
 */
export interface RoundTripAssistantTurn<Target extends keyof AssistantTurnByProtocol> {
  readonly turn: AssistantTurnFor<Target>;
  readonly pendingCallIds: (turn: AssistantTurnFor<Target>) => readonly PendingCall[];
}

/** A call awaiting its result, named the way the target names it. */
export interface PendingCall {
  readonly callId: string;
  readonly name: string;
}


export const roundTripAssistantTurn = async <Source extends keyof AssistantTurnByProtocol, Target extends keyof AssistantTurnByProtocol, SourceTurn>(
  source: Source,
  target: Target,
  turn: SourceTurn,
  codec: SidecarCodec,
  inspect: (turn: SourceTurn) => EncodedRoundTripSidecar<SourceTurn>[],
  verify: (turn: SourceTurn, sourceTurnDigest: RoundTripTurnDigest, version: number) => Promise<boolean>,
  collectCandidates: (turn: SourceTurn) => ReplayContent[],
  // How to name the calls the restored turn leaves awaiting answers. Only the
  // target can answer this, and only once the turn exists.
  pendingCallIds: (turn: AssistantTurnFor<Target>) => readonly PendingCall[],
): Promise<RoundTripAssistantTurn<Target> | undefined> => {
  let selected: { candidate: EncodedRoundTripSidecar<SourceTurn>; sidecar: AnyRoundTripSidecar } | undefined;
  for (const candidate of inspect(turn)) {
    const sidecar = await decodeRoundTripSidecar(codec, candidate.data);
    if (sidecar?.source !== source) continue;
    if (selected !== undefined) throw new Error('Assistant turn has multiple recognized round-trip sidecars');
    selected = { candidate, sidecar };
  }
  if (!hasRoundTripTarget(selected?.sidecar, target)) return undefined;
  const sourceTurn = selected.candidate.withoutSidecar();
  if (!(await verify(sourceTurn, selected.sidecar.sourceTurnDigest, selected.sidecar.v))) return undefined;
  const resolved = await restoreAssistantTurn(target, collectCandidates(sourceTurn), selected.sidecar.targetTurn, selected.sidecar.referencedContentHashes);
  if (!resolved.ok) throw new Error(`Authenticated assistant-turn sidecar restoration failed: ${resolved.reason}`);
  return { turn: resolved.turn, pendingCallIds };
};
