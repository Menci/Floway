import type { ClientOpenAIChatCompletionsStreamEvent } from './index.ts';
import { isOpenAIUsageOnlyEventShape, type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

interface OpenAIChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
}

export function openaiChatCompletionsProtocolFrameToSSEFrame(frame: ProtocolFrame<ClientOpenAIChatCompletionsStreamEvent>, options: { includeUsageChunk: true }): SseFrame;
export function openaiChatCompletionsProtocolFrameToSSEFrame(frame: ProtocolFrame<ClientOpenAIChatCompletionsStreamEvent>, options: OpenAIChatCompletionsSseFrameOptions): SseFrame | null;
export function openaiChatCompletionsProtocolFrameToSSEFrame(frame: ProtocolFrame<ClientOpenAIChatCompletionsStreamEvent>, options: OpenAIChatCompletionsSseFrameOptions): SseFrame | null {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isOpenAIUsageOnlyEventShape(frame.event)) return null;
  return sseFrame(JSON.stringify(frame.event));
}
