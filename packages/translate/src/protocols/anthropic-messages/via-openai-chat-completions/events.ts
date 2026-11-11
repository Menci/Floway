import { createRoundTripStream } from '../../../round-trip/stream.ts';
import type { SidecarCodec } from '../../../types.ts';
import { readOpenAIChatCompletionsEvents } from '../../openai-chat-completions/as-target/events.ts';
import { writeAnthropicMessagesEvents } from '../as-source/events.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, codec: SidecarCodec): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => {
  const stream = createRoundTripStream('anthropicMessages', 'openaiChatCompletions', codec);
  return writeAnthropicMessagesEvents(readOpenAIChatCompletionsEvents(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
