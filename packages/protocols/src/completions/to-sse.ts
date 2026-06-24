import type { CompletionsStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

// Unlike chat-completions/to-sse, this renderer never strips a frame —
// the dump UI's raw-stream view shows upstream truth. Live response
// filtering (the usage-only chunk strip) belongs in the gateway path,
// not here.
export const completionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<CompletionsStreamEvent>): SseFrame => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  return sseFrame(JSON.stringify(frame.event));
};
