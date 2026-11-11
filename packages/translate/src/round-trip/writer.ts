import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './input-assistant-turn.ts';
import type { InputAssistantTurnStateFor } from './reference/assistant-turn-types.ts';
import type { EmittedFieldStates, ReferenceBuilder } from './reference/reference-builder.ts';
import type { TextPlacementIndex } from './text-groups.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

export interface RoundTripWriter<Protocol extends keyof InputAssistantTurnByProtocol> {
  builder: ReferenceBuilder;
  encodeSidecar: (
    choice: number,
    sourceTurnDigest: RoundTripTurnDigest,
    turn: InputAssistantTurnFor<Protocol>,
    contentState: InputAssistantTurnStateFor<Protocol, EmittedFieldStates>,
    textPlacements: TextPlacementIndex,
  ) => Promise<string>;
}
