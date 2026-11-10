import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './assistant-turn.ts';
import type { RoundTripReader } from './reader.ts';
import type { SidecarCodec } from '../types.ts';
import type { ReadFieldStates, ReferenceBuilder } from './reference/reference-builder.ts';
import { collectEmittedFieldPlacements, createReferenceBuilder } from './reference/reference-builder.ts';
import { referenceAssistantTurn } from './reference/reference-selection.ts';
import type { InputAssistantTurnStateFor } from './reference/registry.ts';
import type { RoundTripSidecar } from './sidecar.ts';
import { encodeRoundTripSidecar } from './sidecar.ts';
import type { RoundTripWriter } from './writer.ts';

/**
 * Pairs the reader a target uses with the writer its source uses.
 *
 * One builder spans both halves, which is what lets a sidecar refer to text the
 * target streamed: the reader records where each emitted field came from, and
 * the writer, given that same record, turns it into a reference.
 */
export const createRoundTripStream = <
  Source extends keyof InputAssistantTurnByProtocol,
  Target extends keyof InputAssistantTurnByProtocol,
>(source: Source, target: Target, codec: SidecarCodec) => {
  const builder: ReferenceBuilder = createReferenceBuilder();
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
