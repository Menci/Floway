import { type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const responsesProtocolFrameToSSEFrame = (frame: ProtocolFrame<ResponsesStreamEvent>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(frame.event), frame.event.type) : null;
