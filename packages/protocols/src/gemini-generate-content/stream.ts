import type { GeminiGenerateContentStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseGeminiGenerateContentStreamOptions {
  signal?: AbortSignal | undefined;
}

// `streamGenerateContent?alt=sse` writes one JSON GenerateContentResponse per
// `data:` event and closes without a `[DONE]` sentinel; the terminal chunk is
// the one carrying `finishReason`. The frame stream therefore ends on EOF and
// the per-protocol completion check in `to-result.ts` decides whether the
// upstream actually finished.
//
// A stream that has already produced events can still fail with a bare JSON
// body — no `data:` field, no blank-line framing — which both official clients
// treat as a protocol error. `eventsource-parser` normally drops such a line as
// an unknown field; `patches/eventsource-parser@3.1.0.patch` reads a line that
// opens an object literal as event data instead, so the error arrives as an
// ordinary frame.
// https://github.com/googleapis/js-genai/blob/2cdb3b219eefced7fba83fa76474eea58d836d70/test/unit/api_client_test.ts#L136-L183
// https://github.com/googleapis/go-genai/blob/1f7179b48142fffa8bc0fa6aa1a632633688b16a/api_client_test.go#L431-L439
export const parseGeminiGenerateContentStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseGeminiGenerateContentStreamOptions = {},
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<GeminiGenerateContentStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Gemini generateContent',
    // Gemini is the protocol that can carry a trailing bare JSON body.
    onRawFrame: true,
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
