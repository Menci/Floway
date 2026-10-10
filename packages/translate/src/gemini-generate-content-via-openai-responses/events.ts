import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromOpenAIResponses } from '../shared/ir/sse-from/openai-responses/index.ts';
import { geminiGenerateContentFromIR } from '../shared/ir/sse-to/gemini-generatecontent/index.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec?: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  if (codec === undefined) return geminiGenerateContentFromIR(irFromOpenAIResponses(frames));
  const stream = createIRRoundTripStream('geminiGenerateContent', 'openaiResponses', codec);
  return geminiGenerateContentFromIR(irFromOpenAIResponses(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
