import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './input-assistant-turn.ts';
import type { InputAssistantTurnStateFor } from './reference/assistant-turn-types.ts';
import type { ReadFieldStates, ReferenceBuilder } from './reference/reference-builder.ts';

/** The coordinator's inbound half: a target reader registers the turns it stated. */
export interface RoundTripReader<Protocol extends keyof InputAssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  onAssistantTurn: (
    choice: number,
    turn: InputAssistantTurnFor<Protocol>,
    fieldState: InputAssistantTurnStateFor<Protocol, ReadFieldStates>,
  ) => void;
}
