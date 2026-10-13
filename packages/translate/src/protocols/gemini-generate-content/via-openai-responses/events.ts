import type { AssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripStream } from '../../../round-trip/stream.ts';
import { irFromOpenAIResponses } from '../../openai-responses/as-target/sse-from.ts';
import { geminiGenerateContentFromIR } from '../as-source/sse-to.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripStream('geminiGenerateContent', 'openaiResponses', codec);
  return geminiGenerateContentFromIR(irFromOpenAIResponses(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
