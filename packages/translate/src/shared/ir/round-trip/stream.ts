import type { AssistantTurnSidecarCodec } from '../../../types.ts';
import { createIAT, finalizeThinAssistantTurn, updateIAT, type IAT } from '../iat.ts';
import type { IRProtocol } from '../ir.ts';
import type { IRProjectionResult } from '../round-trip-projection.ts';
import type { IATReference, ThinAssistantTurnFor } from '../thin-types.ts';
import type { IRRoundTripReplayCheck } from './types.ts';

export interface IRRoundTripReader<Protocol extends IRProtocol> {
  iat: IAT;
  onAssistantTurn: (choice: number, turn: ThinAssistantTurnFor<Protocol, IATReference>) => void;
}

export interface IRRoundTripWriter {
  prepareSidecar: (choice: number, replayCheck: IRRoundTripReplayCheck, projection: IRProjectionResult) => Promise<string>;
}

export const createIRRoundTripStream = <Target extends IRProtocol>(source: IRProtocol, target: Target, codec: AssistantTurnSidecarCodec) => {
  const iat = createIAT();
  const turns = new Map<number, ThinAssistantTurnFor<Target, IATReference>>();
  const reader: IRRoundTripReader<Target> = {
    iat,
    onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
  };
  const writer: IRRoundTripWriter = {
    prepareSidecar: async (choice, replayCheck, projection) => {
      updateIAT(iat, projection);
      const finalized = await finalizeThinAssistantTurn(turns.get(choice)!, iat);
      return await codec.encapsulate(source, { source, target, ...finalized, replayCheck });
    },
  };
  return { reader, writer };
};
