import type { AnthropicMessagesStreamEventEx } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const anthropicMessagesProtocolFrameToSSEFrame = (frame: ProtocolFrame<AnthropicMessagesStreamEventEx>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(frame.event), frame.event.type) : null;
