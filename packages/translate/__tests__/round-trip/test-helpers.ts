import { flattenNamespaceTools } from '../../src/protocols/openai-responses/as-source/namespace-tools.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../../src/round-trip/assistant-turn.ts';
import type { RoundTripReader } from '../../src/round-trip/stream.ts';

export const createRoundTripReaderCapture = <Protocol extends keyof AssistantTurnByProtocol>() => {
  const turns = new Map<number, AssistantTurnFor<Protocol>>();
  const roundTrip: RoundTripReader<Protocol> = {
    onAssistantTurn: (choice, turn) => { turns.set(choice, turn); },
  };
  return { turns, roundTrip };
};

export const emptyNamespaceToolNames = () => flattenNamespaceTools({ model: 'test', input: [], tools: [] }).names;
