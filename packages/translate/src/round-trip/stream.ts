import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import type { SidecarCodec } from '../types.ts';
import type { RoundTripSidecar } from './sidecar.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

export interface RoundTripReader<Protocol extends keyof AssistantTurnByProtocol> {
  onAssistantTurn: (choice: number, turn: AssistantTurnFor<Protocol>) => void;
}

export interface RoundTripWriter {
  prepareSidecar: (choice: number, sourceTurnDigest: RoundTripTurnDigest) => Promise<string>;
}

export const createRoundTripStream = <
  Source extends keyof AssistantTurnByProtocol,
  Target extends keyof AssistantTurnByProtocol,
>(source: Source, target: Target, codec: SidecarCodec) => {
  const turns = new Map<number, AssistantTurnFor<Target>>();
  const reader: RoundTripReader<Target> = {
    onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
  };
  const writer: RoundTripWriter = {
    prepareSidecar: async (choice, sourceTurnDigest) => {
      const targetTurn = turns.get(choice);
      if (targetTurn === undefined) throw new Error(`Missing native assistant turn for choice ${choice}`);
      return await codec.encode({ v: 1, source, target, targetTurn, sourceTurnDigest } satisfies RoundTripSidecar<Target>);
    },
  };
  return { reader, writer };
};

export interface RoundTripOutputOptions {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter;
}
