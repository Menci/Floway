import type { OpenAIChatCompletionsStreamEvent } from './index.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

interface OpenAIChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
}

export const openaiChatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>, options: OpenAIChatCompletionsSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isOpenAIUsageOnlyEventShape(frame.event)) return null;
  return sseFrame(JSON.stringify(frame.event));
};
