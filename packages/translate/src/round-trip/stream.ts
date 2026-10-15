import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import type { AssistantTurnSidecarCodec } from './codec.ts';
import type { RoundTripReplayCheck } from './replay-check.ts';
import type { AssistantTurnStateFor } from './thin/assistant-turn.ts';
import { collectContentViews, createReferenceBuilder, finalizeAssistantTurnReferences, type ContentStates, type FieldStates, type ReferenceBuilder } from './thin/reference-builder.ts';

export interface RoundTripReader<Protocol extends keyof AssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  onAssistantTurn: (
    choice: number,
    turn: AssistantTurnFor<Protocol>,
    fieldState: AssistantTurnStateFor<Protocol, FieldStates>,
  ) => void;
}

export interface RoundTripWriter<Protocol extends keyof AssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  prepareSidecar: (
    choice: number,
    replayCheck: RoundTripReplayCheck,
    turn: AssistantTurnFor<Protocol>,
    contentState: AssistantTurnStateFor<Protocol, ContentStates>,
  ) => Promise<string>;
}

export const createRoundTripStream = <
  Source extends keyof AssistantTurnByProtocol,
  Target extends keyof AssistantTurnByProtocol,
>(source: Source, target: Target, codec: AssistantTurnSidecarCodec) => {
  const builder = createReferenceBuilder();
  const turns = new Map<number, {
    turn: AssistantTurnFor<Target>;
    fieldState: AssistantTurnStateFor<Target, FieldStates>;
  }>();
  const reader: RoundTripReader<Target> = {
    builder,
    onAssistantTurn: (choice, turn, fieldState) => { turns.set(choice, { turn, fieldState }); },
  };
  const writer: RoundTripWriter<Source> = {
    builder,
    prepareSidecar: async (choice, replayCheck, turn, contentState) => {
      const pending = turns.get(choice);
      if (pending === undefined) throw new Error(`Missing native assistant turn for choice ${choice}`);
      const finalized = await finalizeAssistantTurnReferences(
        pending.turn,
        pending.fieldState,
        builder,
        collectContentViews(turn, contentState),
      );
      return await codec.encode(source, { target, ...finalized, replayCheck });
    },
  };
  return { reader, writer };
};

export interface RoundTripOutputOptions<Protocol extends keyof AssistantTurnByProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
