import type { GeminiGenerateContentStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseGeminiGenerateContentStreamOptions {
  signal?: AbortSignal;
}

// `streamGenerateContent?alt=sse` writes one JSON GenerateContentResponse per
// `data:` event and closes without a `[DONE]` sentinel; the terminal chunk is
// the one carrying `finishReason`. The frame stream therefore ends on EOF and
// the per-protocol completion check in `to-result.ts` decides whether the
// upstream actually finished.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
export const parseGeminiGenerateContentStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseGeminiGenerateContentStreamOptions = {},
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<GeminiGenerateContentStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Gemini generateContent',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
