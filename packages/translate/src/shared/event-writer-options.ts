import type { AssistantTurnProtocol } from '../round-trip/input-assistant-turn.ts';
import type { RoundTripWriter } from '../round-trip/writer.ts';

/**
 * What a source's emitted stream is stated with.
 *
 * `id` and `created` are the response identity the client sees; only the
 * round trip is this layer's concern.
 */
export interface SourceEventWriterOptions<Protocol extends AssistantTurnProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
