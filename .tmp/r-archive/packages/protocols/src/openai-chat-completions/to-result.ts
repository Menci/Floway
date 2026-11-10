import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResultEx } from './index.ts';
import { reassembleOpenAIChatCompletionsEvents } from './reassemble.ts';
import { type ProtocolFrame } from '../common/index.ts';

const openaiChatCompletionsEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): AsyncGenerator<OpenAIChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }
};

export const collectOpenAIChatCompletionsProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): Promise<OpenAIChatCompletionsResultEx> => {
  return await reassembleOpenAIChatCompletionsEvents(openaiChatCompletionsEventsUntilDone(frames));
};
