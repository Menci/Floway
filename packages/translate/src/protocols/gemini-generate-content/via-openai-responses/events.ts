import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { readOpenAIResponsesEvents } from '../../openai-responses/as-target/events.ts';
import { writeGeminiGenerateContentEvents } from '../as-source/events.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec: SidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripCoordinator('geminiGenerateContent', 'openaiResponses', codec);
  return writeGeminiGenerateContentEvents(readOpenAIResponsesEvents(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
