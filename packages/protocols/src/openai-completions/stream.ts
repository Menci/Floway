import type { OpenAICompletionsStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseOpenAICompletionsStreamOptions {
  signal?: AbortSignal;
}

// The upstream's SSE body as protocol frames. Transport framing ends here: what comes out
// carries `text_completion` chunks and a terminal frame, and nothing that reads it knows how
// those arrived.
export const parseOpenAICompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseOpenAICompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<OpenAICompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<OpenAICompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'OpenAI Completions',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
