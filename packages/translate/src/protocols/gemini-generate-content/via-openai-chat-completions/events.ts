import { createRoundTripStream } from '../../../round-trip/stream.ts';
import type { SidecarCodec } from '../../../types.ts';
import { readOpenAIChatCompletionsEvents } from '../../openai-chat-completions/as-target/events.ts';
import { writeGeminiGenerateContentEvents } from '../as-source/events.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, codec: SidecarCodec, maxChoices = 1): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> => {
  const stream = createRoundTripStream('geminiGenerateContent', 'openaiChatCompletions', codec);
  return writeGeminiGenerateContentEvents(readOpenAIChatCompletionsEvents(frames, { maxChoices, roundTrip: stream.reader }), { roundTrip: stream.writer });
};
