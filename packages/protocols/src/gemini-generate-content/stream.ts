import type { GeminiGenerateContentStreamEvent } from './index.ts';
import { createGeminiGenerateContentCandidateCompletion, GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, isGeminiGenerateContentErrorEvent, isGeminiGenerateContentTerminalEvent } from './to-result.ts';
import { decodeSseEvents, protocolDecodeError, protocolSseError, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';
import { isJsonObject } from '../common/json.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseGeminiGenerateContentStreamOptions {
  signal?: AbortSignal | undefined;
}

export const decodeGeminiGenerateContentStream = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<GeminiGenerateContentStreamEvent, Failure> {
  const completion = createGeminiGenerateContentCandidateCompletion();
  let ended = false;
  for await (const item of decodeSseEvents<GeminiGenerateContentStreamEvent, Failure>(body, {
    protocol: 'Gemini generateContent', onRawFrame: true, onDone: () => { ended = true; }, ignoreEvents: () => ended,
  })) {
    if (!item.ok) {
      yield item;
      return;
    }
    const event = item.value.data;
    if (isGeminiGenerateContentErrorEvent(event)) {
      yield protocolSseError('Gemini generateContent', event);
      return;
    }
    if ('candidates' in event && event.candidates !== undefined && (!Array.isArray(event.candidates) || !event.candidates.every(isJsonObject))) {
      yield protocolDecodeError('Expected an array of candidates in the Gemini stream event', event);
      return;
    }
    ended = isGeminiGenerateContentTerminalEvent(event);
    yield { ok: true, value: event };
    completion.observe(event);
  }
  if (!ended && !completion.isComplete()) yield protocolDecodeError(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};

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
