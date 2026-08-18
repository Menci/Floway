import type { GeminiGenerateContentStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const geminiGenerateContentProtocolFrameToSSEFrame = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): SseFrame | null => (frame.type === 'done' ? null : sseFrame(JSON.stringify(frame.event)));
