import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './assistant-turn.ts';
import type { SidecarCodec } from '../types.ts';
import type { InputAssistantTurnStateFor } from './reference/assistant-turn.ts';
import { collectEmittedFieldPlacements, createReferenceBuilder, type EmittedFieldStates, type ReadFieldStates, type ReferenceBuilder } from './reference/reference-builder.ts';
import { referenceAssistantTurn } from './reference/reference-selection.ts';
import type { RoundTripSidecar } from './sidecar.ts';
import { encodeRoundTripSidecar } from './sidecar.ts';
import type { TextPlacementIndex } from './text-groups.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

export interface RoundTripReader<Protocol extends keyof InputAssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  onAssistantTurn: (
    choice: number,
    turn: InputAssistantTurnFor<Protocol>,
    fieldState: InputAssistantTurnStateFor<Protocol, ReadFieldStates>,
  ) => void;
}

export interface RoundTripWriter<Protocol extends keyof InputAssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  prepareSidecar: (
    choice: number,
    sourceTurnDigest: RoundTripTurnDigest,
    turn: InputAssistantTurnFor<Protocol>,
    contentState: InputAssistantTurnStateFor<Protocol, EmittedFieldStates>,
    textPlacements: TextPlacementIndex,
  ) => Promise<string>;
}

export const createRoundTripStream = <
  Source extends keyof InputAssistantTurnByProtocol,
  Target extends keyof InputAssistantTurnByProtocol,
>(source: Source, target: Target, codec: SidecarCodec) => {
  const builder = createReferenceBuilder();
  const turns = new Map<number, {
    turn: InputAssistantTurnFor<Target>;
    fieldState: InputAssistantTurnStateFor<Target, ReadFieldStates>;
  }>();
  const reader: RoundTripReader<Target> = {
    builder,
    onAssistantTurn: (choice, turn, fieldState) => { turns.set(choice, { turn, fieldState }); },
  };
  const writer: RoundTripWriter<Source> = {
    builder,
    prepareSidecar: async (choice, sourceTurnDigest, turn, contentState, textPlacements) => {
      const pending = turns.get(choice);
      if (pending === undefined) throw new Error(`Missing native assistant turn for choice ${choice}`);
      const finalized = await referenceAssistantTurn(
        pending.turn,
        pending.fieldState,
        builder,
        collectEmittedFieldPlacements(turn, contentState, textPlacements),
      );
      return await encodeRoundTripSidecar(codec, { v: 1, source, target, ...finalized, sourceTurnDigest } satisfies RoundTripSidecar<Target>);
    },
  };
  return { reader, writer };
};

export interface SourceStreamOutputOptions<Protocol extends keyof InputAssistantTurnByProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
