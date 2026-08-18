import type { CompletionsStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseCompletionsStreamOptions {
  signal?: AbortSignal;
}

// The upstream's SSE body as protocol frames. Transport framing ends here: what comes out
// carries `text_completion` chunks and a terminal frame, and nothing that reads it knows how
// those arrived.
export const parseCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseCompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<CompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<CompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Completions',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
