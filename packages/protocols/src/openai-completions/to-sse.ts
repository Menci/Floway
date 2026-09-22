import type { OpenAICompletionsStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const openaiCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<OpenAICompletionsStreamEvent>): SseFrame =>
  (frame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(frame.event)));
