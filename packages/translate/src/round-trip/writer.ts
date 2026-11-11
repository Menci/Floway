import type { InputAssistantTurnByProtocol, InputAssistantTurnFor } from './input-assistant-turn.ts';
import type { InputAssistantTurnStateFor } from './reference/assistant-turn-types.ts';
import type { EmittedFieldStates, ReferenceBuilder } from './reference/reference-builder.ts';
import type { TextPlacementIndex } from './text-groups.ts';
import type { RoundTripTurnDigest } from './turn-digest.ts';

/** The coordinator's outbound half: a source writer states its turn's sidecar. */
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

/**
 * What a source's emitted stream is stated with.
 *
 * `id` and `created` are the response identity the client sees; only the
 * round trip is this layer's concern.
 */
export interface SourceEventWriterOptions<Protocol extends keyof InputAssistantTurnByProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
