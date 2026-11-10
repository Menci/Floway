import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from '../../src/round-trip/assistant-turn.ts';
import type { InputAssistantTurnStateFor } from '../../src/round-trip/reference/assistant-turn.ts';
import { createReferenceBuilder, type EmittedFieldStates, type ReadFieldStates } from '../../src/round-trip/reference/reference-builder.ts';
import type { RoundTripReader, RoundTripWriter } from '../../src/round-trip/stream.ts';
import type { RoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';

export const createRoundTripReaderCapture = <Protocol extends keyof InputAssistantTurnByProtocol>() => {
  const builder = createReferenceBuilder();
  const turns = new Map<number, {
    turn: InputAssistantTurnFor<Protocol>;
    fieldState: InputAssistantTurnStateFor<Protocol, ReadFieldStates>;
  }>();
  const roundTrip: RoundTripReader<Protocol> = {
    builder,
    onAssistantTurn: (choice, turn, fieldState) => { turns.set(choice, { turn, fieldState }); },
  };
  return { builder, turns, roundTrip };
};

export const captureRoundTripWriter = <Protocol extends keyof InputAssistantTurnByProtocol>() => {
  const builder = createReferenceBuilder();
  const prepared: Array<{
    choice: number;
    sourceTurnDigest: RoundTripTurnDigest;
    turn: InputAssistantTurnFor<Protocol>;
    contentState: InputAssistantTurnStateFor<Protocol, EmittedFieldStates>;
  }> = [];
  const roundTrip: RoundTripWriter<Protocol> = {
    builder,
    prepareSidecar: async (choice, sourceTurnDigest, turn, contentState) => {
      prepared.push({ choice, sourceTurnDigest, turn, contentState });
      return `sidecar-${choice}`;
    },
  };
  return { builder, prepared, roundTrip };
};
