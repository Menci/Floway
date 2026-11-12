import type { AssistantTurnByProtocol } from '../round-trip/assistant-turn.ts';
import type { RoundTripWriter } from '../round-trip/stream.ts';

export interface SourceEventWriterOptions<Protocol extends keyof AssistantTurnByProtocol> {
  id?: string;
  created?: number;
  roundTrip: RoundTripWriter<Protocol>;
}
