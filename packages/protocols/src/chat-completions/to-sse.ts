import type { ChatCompletionsStreamEvent } from './index.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

interface ChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
}

export const chatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>, options: ChatCompletionsSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isOpenAIUsageOnlyEventShape(frame.event)) return null;
  return sseFrame(JSON.stringify(frame.event));
};
