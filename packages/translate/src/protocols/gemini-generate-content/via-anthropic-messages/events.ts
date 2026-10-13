import type { AssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripStream } from '../../../round-trip/stream.ts';
import { irFromAnthropicMessages } from '../../anthropic-messages/as-target/sse-from.ts';
import { geminiGenerateContentFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, codec: AssistantTurnSidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripStream('geminiGenerateContent', 'anthropicMessages', codec);
  return geminiGenerateContentFromIR(irFromAnthropicMessages(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
