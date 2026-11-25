import { openaiChatCompletionsErrorPayloadMessage } from './errors.ts';
import type { OpenAIChatCompletionsStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { eventFrame, type ParsedProtocolFrame } from '../common/sse.ts';

export interface ParseOpenAIChatCompletionsStreamOptions {
  signal?: AbortSignal | undefined;
}

export const parseOpenAIChatCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseOpenAIChatCompletionsStreamOptions = {},
): AsyncGenerator<ParsedProtocolFrame<OpenAIChatCompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<OpenAIChatCompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'OpenAI Chat Completions',
  })) {
    if (frame.type === 'done' || frame.type === 'error') {
      yield frame;
      return;
    }
    const errorMessage = openaiChatCompletionsErrorPayloadMessage(frame.data);
    if (errorMessage) {
      yield { type: 'error', cause: { message: `Upstream OpenAI Chat Completions SSE error: ${errorMessage}`, cause: frame.data } };
      return;
    }
    yield eventFrame(frame.data);
  }
})();
