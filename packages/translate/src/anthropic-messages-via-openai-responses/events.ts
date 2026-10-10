import { createIRRoundTripStream } from '../shared/ir/round-trip/stream.ts';
import { irFromOpenAIResponses } from '../shared/ir/sse-from/openai-responses/index.ts';
import { anthropicMessagesFromIR } from '../shared/ir/sse-to/anthropic-messages/index.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec?: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  if (codec === undefined) return anthropicMessagesFromIR(irFromOpenAIResponses(frames));
  const stream = createIRRoundTripStream('anthropicMessages', 'openaiResponses', codec);
  return anthropicMessagesFromIR(irFromOpenAIResponses(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
