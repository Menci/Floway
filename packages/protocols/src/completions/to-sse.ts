import type { CompletionsStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

// Completions streams render verbatim — the dump UI shows upstream truth.
// Usage-only chunk filtering, when needed, belongs in the live gateway
// path, not in this renderer.
export const completionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<CompletionsStreamEvent>): SseFrame => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  return sseFrame(JSON.stringify(frame.event));
};
