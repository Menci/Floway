import type { AssistantTurnProtocol } from '../round-trip/input-assistant-turn.ts';
import type { RoundTripWriter } from '../round-trip/writer.ts';

export interface SourceEventWriterOptions<Protocol extends AssistantTurnProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
