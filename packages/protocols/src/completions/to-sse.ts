import type { CompletionsStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

// Render one ProtocolFrame as an SseFrame for the dashboard's raw stream
// view. Passthrough has no shape decisions to make: events serialize via
// JSON.stringify, the terminal frame is `[DONE]`. The gateway never strips
// frames here — that filtering is the live response path's job, not the
// dump renderer's — so this matches what the upstream actually emitted.
export const completionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<CompletionsStreamEvent>): SseFrame => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  return sseFrame(JSON.stringify(frame.event));
};
