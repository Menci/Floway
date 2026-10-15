import { flattenNamespaceTools } from '../../src/protocols/openai-responses/as-source/namespace-tools.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../../src/round-trip/assistant-turn.ts';
import type { RoundTripReplayCheck } from '../../src/round-trip/replay-check.ts';
import type { RoundTripReader, RoundTripWriter } from '../../src/round-trip/stream.ts';
import type { AssistantTurnStateFor } from '../../src/round-trip/thin/assistant-turn.ts';
import { createReferenceBuilder, type ContentStates, type FieldStates } from '../../src/round-trip/thin/reference-builder.ts';

export const createRoundTripReaderCapture = <Protocol extends keyof AssistantTurnByProtocol>() => {
  const builder = createReferenceBuilder();
  const turns = new Map<number, {
    turn: AssistantTurnFor<Protocol>;
    fieldState: AssistantTurnStateFor<Protocol, FieldStates>;
  }>();
  const roundTrip: RoundTripReader<Protocol> = {
    builder,
    onAssistantTurn: (choice, turn, fieldState) => { turns.set(choice, { turn, fieldState }); },
  };
  return { builder, turns, roundTrip };
};

export const captureRoundTripWriter = <Protocol extends keyof AssistantTurnByProtocol>() => {
  const builder = createReferenceBuilder();
  const prepared: Array<{
    choice: number;
    replayCheck: RoundTripReplayCheck;
    turn: AssistantTurnFor<Protocol>;
    contentState: AssistantTurnStateFor<Protocol, ContentStates>;
  }> = [];
  const roundTrip: RoundTripWriter<Protocol> = {
    builder,
    prepareSidecar: async (choice, replayCheck, turn, contentState) => {
      prepared.push({ choice, replayCheck, turn, contentState });
      return `sidecar-${choice}`;
    },
  };
  return { builder, prepared, roundTrip };
};

export const emptyNamespaceToolNames = () => flattenNamespaceTools({ model: 'test', input: [], tools: [] }).names;
