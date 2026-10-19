import type { AssistantTurnByProtocol, AssistantTurnFor } from './assistant-turn.ts';
import type { SidecarCodec } from '../types.ts';
import type { AssistantTurnStateFor } from './reference/assistant-turn.ts';
import { collectContentViews, createReferenceBuilder, type ContentStates, type FieldStates, type ReferenceBuilder } from './reference/reference-builder.ts';
import { finalizeAssistantTurnReferences } from './reference/reference-selection.ts';
import type { RoundTripSidecar } from './sidecar.ts';
import { encodeRoundTripSidecar } from './sidecar.ts';
import type { TextPlacementIndex } from './text-groups.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

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
    sourceTurnDigest: RoundTripTurnDigest,
    turn: AssistantTurnFor<Protocol>,
    contentState: AssistantTurnStateFor<Protocol, ContentStates>,
    textViews: TextPlacementIndex,
  ) => Promise<string>;
}

export const createRoundTripStream = <
  Source extends keyof AssistantTurnByProtocol,
  Target extends keyof AssistantTurnByProtocol,
>(source: Source, target: Target, codec: SidecarCodec) => {
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
    prepareSidecar: async (choice, sourceTurnDigest, turn, contentState, textViews) => {
      const pending = turns.get(choice);
      if (pending === undefined) throw new Error(`Missing native assistant turn for choice ${choice}`);
      const finalized = await finalizeAssistantTurnReferences(
        pending.turn,
        pending.fieldState,
        builder,
        collectContentViews(turn, contentState, textViews),
      );
      return await encodeRoundTripSidecar(codec, { v: 1, source, target, ...finalized, sourceTurnDigest } satisfies RoundTripSidecar<Target>);
    },
  };
  return { reader, writer };
};

export interface RoundTripOutputOptions<Protocol extends keyof AssistantTurnByProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
