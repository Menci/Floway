import { chatCompletionsErrorPayloadMessage } from './errors.ts';
import type { ChatCompletionsStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseChatCompletionsStreamOptions {
  signal?: AbortSignal;
}

export const parseChatCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseChatCompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<ChatCompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Chat Completions',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    // Some upstreams report mid-stream failures via `{error: {message, type}}`
    // instead of an HTTP failure; bubble as a thrown Error so the target
    // boundary 502s.
    const errorMessage = chatCompletionsErrorPayloadMessage(frame.data);
    if (errorMessage) throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
    yield eventFrame(frame.data);
  }
})();
