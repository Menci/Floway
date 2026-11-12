import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { readOpenAIResponsesEvents } from '../../openai-responses/as-target/events.ts';
import { writeAnthropicMessagesEvents } from '../as-source/events.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, codec: SidecarCodec): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  const stream = createRoundTripCoordinator('anthropicMessages', 'openaiResponses', codec);
  return writeAnthropicMessagesEvents(readOpenAIResponsesEvents(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
