import type { ResponsesStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const responsesProtocolFrameToSSEFrame = (frame: ProtocolFrame<ResponsesStreamEvent>): SseFrame =>
  (frame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(frame.event), frame.event.type));
