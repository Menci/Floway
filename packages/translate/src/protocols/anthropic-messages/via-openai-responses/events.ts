import type { AssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripStream } from '../../../round-trip/stream.ts';
import { irFromOpenAIResponses } from '../../openai-responses/as-target/sse-from.ts';
import { anthropicMessagesFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  const stream = createRoundTripStream('anthropicMessages', 'openaiResponses', codec);
  return anthropicMessagesFromIR(irFromOpenAIResponses(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
