import type { GeminiGenerateContentStreamEvent } from './index.ts';
import { isGeminiGenerateContentErrorEvent } from './to-result.ts';
import { type ProtocolFrame, type SseFrame, type SseTrailerFrame, sseFrame, sseTrailerFrame } from '../common/index.ts';

// Google streams can finish with a bare JSON error after ordinary SSE chunks.
// JS and Go SDKs explicitly recognize this trailer; data-prefixed errors are not checked.
// https://github.com/googleapis/js-genai/blob/2cdb3b219eefced7fba83fa76474eea58d836d70/test/unit/api_client_test.ts#L136-L183
// https://github.com/googleapis/go-genai/blob/1f7179b48142fffa8bc0fa6aa1a632633688b16a/api_client_test.go#L431-L439
export const geminiGenerateContentProtocolFrameToSSEFrame = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): SseFrame | SseTrailerFrame | null => {
  if (frame.type === 'done') return null;
  const data = JSON.stringify(frame.event);
  return isGeminiGenerateContentErrorEvent(frame.event) ? sseTrailerFrame(data) : sseFrame(data);
};
