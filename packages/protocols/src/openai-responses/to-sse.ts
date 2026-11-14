import type { OpenAIResponsesStreamEventEx } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const openaiResponsesProtocolFrameToSSEFrame = (frame: ProtocolFrame<OpenAIResponsesStreamEventEx>): SseFrame =>
  (frame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(frame.event), frame.event.type));
