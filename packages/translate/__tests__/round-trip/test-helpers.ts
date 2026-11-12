import { flattenNamespaceTools } from '../../src/protocols/openai-responses/as-source/namespace-tools.ts';
import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from '../../src/round-trip/input-assistant-turn.ts';
import type { RoundTripReader } from '../../src/round-trip/reader.ts';
import type { InputAssistantTurnStateFor } from '../../src/round-trip/reference/assistant-turn-types.ts';
import { createReferenceBuilder, type EmittedFieldStates, type ReadFieldStates } from '../../src/round-trip/reference/reference-builder.ts';
import type { RoundTripTurnDigest } from '../../src/round-trip/turn-digest.ts';
import type { RoundTripWriter } from '../../src/round-trip/writer.ts';

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
    encodeSidecar: async (choice, sourceTurnDigest, turn, contentState) => {
      prepared.push({ choice, sourceTurnDigest, turn, contentState });
      return `sidecar-${choice}`;
    },
  };
  return { builder, prepared, roundTrip };
};

export const emptyNamespaceToolNames = () => flattenNamespaceTools({ model: 'test', input: [], tools: [] }).names;
