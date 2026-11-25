import { openaiChatCompletionsErrorPayloadMessage } from './errors.ts';
import type { OpenAIChatCompletionsStreamEvent } from './index.ts';
import { decodeSseEvents, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseOpenAIChatCompletionsStreamOptions {
  signal?: AbortSignal | undefined;
}

export const decodeOpenAIChatCompletionsStream = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIChatCompletionsStreamEvent, Failure> {
  let errored = false;
  for await (const item of decodeSseEvents<OpenAIChatCompletionsStreamEvent, Failure>(body, {
    protocol: 'OpenAI Chat Completions', ignoreEvents: () => errored,
  })) {
    if (!item.ok) {
      yield item;
      return;
    }
    const { data, eventName } = item.value;
    errored = eventName === 'error' || openaiChatCompletionsErrorPayloadMessage(data) !== null;
    yield { ok: true, value: data };
  }
};

export const parseOpenAIChatCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseOpenAIChatCompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<OpenAIChatCompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'OpenAI Chat Completions',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    // Some upstreams report mid-stream failures via `{error: {message, type}}`
    // instead of an HTTP failure; bubble as a thrown Error so the target
    // boundary 502s.
    const errorMessage = openaiChatCompletionsErrorPayloadMessage(frame.data);
    if (errorMessage) throw new Error(`Upstream OpenAI Chat Completions SSE error: ${errorMessage}`);
    yield eventFrame(frame.data);
  }
})();
