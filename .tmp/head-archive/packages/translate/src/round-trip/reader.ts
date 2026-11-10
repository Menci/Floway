import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './assistant-turn.ts';
import type { ReadFieldStates, ReferenceBuilder } from './reference/reference-builder.ts';
import type { InputAssistantTurnStateFor } from './reference/registry.ts';

/** The coordinator's inbound half: a target reader registers the turns it stated. */
export interface RoundTripReader<Protocol extends keyof InputAssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  onAssistantTurn: (
    choice: number,
    turn: InputAssistantTurnFor<Protocol>,
    fieldState: InputAssistantTurnStateFor<Protocol, ReadFieldStates>,
  ) => void;
}
