import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import { readOpenAIChatCompletionsEvents } from '../../openai-chat-completions/as-target/events.ts';
import { writeAnthropicMessagesEvents } from '../as-source/events.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, codec: SidecarCodec, maxChoices = 1): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  const stream = createRoundTripCoordinator('anthropicMessages', 'openaiChatCompletions', codec);
  return writeAnthropicMessagesEvents(readOpenAIChatCompletionsEvents(frames, { maxChoices, roundTrip: stream.reader }), { roundTrip: stream.writer });
};
