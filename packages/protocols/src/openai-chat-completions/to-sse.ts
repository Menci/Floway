import type { OpenAIChatCompletionsStreamEvent } from './index.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

interface OpenAIChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
  continuousUsageStats?: boolean;
}

export const openaiChatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>, options: OpenAIChatCompletionsSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isOpenAIUsageOnlyEventShape(frame.event)) return null;
  if (!(options.includeUsageChunk && options.continuousUsageStats) && Array.isArray(frame.event.choices) && frame.event.choices.length > 0 && frame.event.usage !== undefined) {
    const { usage: _usage, ...event } = frame.event;
    return sseFrame(JSON.stringify(event));
  }
  return sseFrame(JSON.stringify(frame.event));
};
