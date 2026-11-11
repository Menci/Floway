import { createRoundTripCoordinator } from '../../../round-trip/coordinator.ts';
import type { SidecarCodec } from '../../../round-trip/codec.ts';
import { readOpenAIChatCompletionsEvents } from '../../openai-chat-completions/as-target/events.ts';
import { writeGeminiGenerateContentEvents } from '../as-source/events.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, codec: SidecarCodec): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripCoordinator('geminiGenerateContent', 'openaiChatCompletions', codec);
  return writeGeminiGenerateContentEvents(readOpenAIChatCompletionsEvents(frames, { roundTrip: stream.reader }), { roundTrip: stream.writer });
};
