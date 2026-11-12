import { createRoundTripStream } from '../../../round-trip/stream.ts';
import type { SidecarCodec } from '../../../types.ts';
import { readOpenAIResponsesEvents } from '../../openai-responses/as-target/events.ts';
import { writeGeminiGenerateContentEvents } from '../as-source/events.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec: SidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripStream('geminiGenerateContent', 'openaiResponses', codec);
  return writeGeminiGenerateContentEvents(readOpenAIResponsesEvents(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
