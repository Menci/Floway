import type { AssistantTurnSidecarCodec } from '../../../types.ts';
import type { IRProtocol } from '../ir.ts';
import type { RemoveThinReferences, ThinAssistantTurnFor, ThinReference } from '../thin-types.ts';
import { hydrate } from '../thin.ts';
import type { IRRoundTripAssistantTurnInspection, IRRoundTripReplayCheck, IRRoundTripSidecarEnvelope } from './types.ts';

export type PreparedIRRoundTripAssistantTurn<SourceTurn, Target extends IRProtocol> =
  | { kind: 'source'; turn: SourceTurn }
  | { kind: 'target'; turn: RemoveThinReferences<ThinAssistantTurnFor<Target, ThinReference>> };

export const prepareIRRoundTripAssistantTurn = async <Source extends IRProtocol, Target extends IRProtocol, SourceTurn>(
  source: Source,
  target: Target,
  turn: SourceTurn,
  codec: AssistantTurnSidecarCodec,
  inspect: (turn: SourceTurn) => IRRoundTripAssistantTurnInspection,
  verify: (turn: SourceTurn, replayCheck: IRRoundTripReplayCheck) => Promise<boolean>,
  clean: (turn: SourceTurn) => SourceTurn,
): Promise<PreparedIRRoundTripAssistantTurn<SourceTurn, Target>> => {
  const inspection = inspect(turn);
  const useSourceTurn = (): PreparedIRRoundTripAssistantTurn<SourceTurn, Target> => ({ kind: 'source', turn: clean(turn) });
  if (inspection.sidecars.length !== 1) return useSourceTurn();

  const decoded = await codec.unencapsulate(source, inspection.sidecars[0]);
  if (decoded === undefined) return useSourceTurn();

  const sidecar = decoded as IRRoundTripSidecarEnvelope;
  if (sidecar.target !== target || !(await verify(turn, sidecar.replayCheck))) return useSourceTurn();

  const hydrated = await hydrate(
    inspection.candidates,
    sidecar.thinAssistantTurn as ThinAssistantTurnFor<Target, ThinReference>,
    sidecar.referencedContents,
  );
  return hydrated.ok ? { kind: 'target', turn: hydrated.turn as RemoveThinReferences<ThinAssistantTurnFor<Target, ThinReference>> } : useSourceTurn();
};
