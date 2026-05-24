import { type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

export const geminiProtocolFrameToSSEFrame = (frame: ProtocolFrame<GeminiStreamEvent>): SseFrame | null => (frame.type === 'done' ? null : sseFrame(JSON.stringify(frame.event)));
