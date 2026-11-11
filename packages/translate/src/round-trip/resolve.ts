import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './input-assistant-turn.ts';
import type { SidecarCodec } from '../types.ts';
import { restoreAssistantTurn } from './reference/restore.ts';
import type { ReplayContent } from './reference/types.ts';
import { decodeRoundTripSidecar, hasRoundTripTarget, type AnyRoundTripSidecar } from './sidecar.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

export interface SidecarOccurrence<Turn> {
  readonly data: string;
  readonly withoutSidecar: () => Turn;
}

export interface SidecarRecognition<Turn> {
  readonly inspect: (turn: Turn) => SidecarOccurrence<Turn>[];
  readonly verify: (turn: Turn, digest: RoundTripTurnDigest, version: number) => Promise<boolean>;
  readonly collectCandidates: (turn: Turn) => ReplayContent[];
}

export const roundTripAssistantTurn = async <Source extends keyof InputAssistantTurnByProtocol, Target extends keyof InputAssistantTurnByProtocol, SourceTurn>(
  source: Source,
  target: Target,
  turn: SourceTurn,
  codec: SidecarCodec,
  recognition: SidecarRecognition<SourceTurn>,
): Promise<InputAssistantTurnFor<Target> | undefined> => {
  const { inspect, verify, collectCandidates } = recognition;
  let selected: { carrier: SidecarOccurrence<SourceTurn>; sidecar: AnyRoundTripSidecar } | undefined;
  for (const carrier of inspect(turn)) {
    const sidecar = await decodeRoundTripSidecar(codec, source, carrier.data);
    if (sidecar === undefined) continue;
    if (selected !== undefined) throw new Error('Assistant turn has multiple recognized round-trip sidecars');
    selected = { carrier, sidecar };
  }
  if (!hasRoundTripTarget(selected?.sidecar, target)) return undefined;
  const sourceTurn = selected.carrier.withoutSidecar();
  if (!(await verify(sourceTurn, selected.sidecar.sourceTurnDigest, selected.sidecar.v))) return undefined;
  const resolved = await restoreAssistantTurn(target, collectCandidates(sourceTurn), selected.sidecar.targetTurn, selected.sidecar.referencedContentHashes);
  if (!resolved.ok) throw new Error(`Authenticated assistant-turn sidecar restoration failed: ${resolved.reason}`);
  return resolved.value;
};
