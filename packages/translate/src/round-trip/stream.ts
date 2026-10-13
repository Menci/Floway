import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import type { AssistantTurnSidecarCodec } from './codec.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';

export interface RoundTripReader<Protocol extends keyof AssistantTurnByProtocol> {
  onAssistantTurn: (choice: number, turn: AssistantTurnFor<Protocol>) => void;
}

export interface RoundTripWriter {
  prepareSidecar: (choice: number, replayCheck: RoundTripReplayCheck) => Promise<string>;
}

export const createRoundTripStream = <
  Source extends keyof AssistantTurnByProtocol,
  Target extends keyof AssistantTurnByProtocol,
>(source: Source, target: Target, codec: AssistantTurnSidecarCodec) => {
  const turns = new Map<number, AssistantTurnFor<Target>>();
  const reader: RoundTripReader<Target> = {
    onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
  };
  const writer: RoundTripWriter = {
    prepareSidecar: async (choice, replayCheck) => {
      const assistantTurn = turns.get(choice);
      if (assistantTurn === undefined) throw new Error(`Missing native assistant turn for choice ${choice}`);
      return await codec.encode(source, { target, assistantTurn, replayCheck });
    },
  };
  return { reader, writer };
};

export interface RoundTripOutputOptions {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter;
}
