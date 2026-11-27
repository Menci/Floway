import { openaiChatCompletionsErrorPayloadMessage } from './errors.ts';
import type { OpenAIChatCompletionsStreamEvent } from './index.ts';
import { decodeOpenAISseWireEvents, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';
import { isJsonObject, type JsonObject } from '../common/json.ts';
import { parseTargetStreamFrames, protocolDecodeError } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseOpenAIChatCompletionsStreamOptions {
  signal?: AbortSignal | undefined;
}

export const decodeOpenAIChatCompletionsStream = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<OpenAIChatCompletionsStreamEvent, Failure> {
  for await (const item of decodeOpenAISseWireEvents<OpenAIChatCompletionsStreamEvent & JsonObject, Failure>(body, 'OpenAI Chat Completions')) {
    if (!item.ok) {
      yield item;
      return;
    }
    const { data, eventName } = item.value;
    const invalid = (field: string, expected: string, value: unknown) =>
      protocolDecodeError(`Expected OpenAI Chat Completions SSE ${field} to be ${expected}`, value, data, eventName);
    if (!Array.isArray(data.choices)) {
      yield invalid('choices', 'an array', data.choices);
      return;
    }
    let choices: OpenAIChatCompletionsStreamEvent['choices'] | undefined;
    for (const [index, choice] of data.choices.entries()) {
      const field = `choices[${index}]`;
      if (!isJsonObject(choice)) {
        yield invalid(field, 'an object', choice);
        return;
      }
      if (choice.delta === undefined) {
        // Azure filtering choices and usage-only placeholders can omit delta.
        // https://github.com/dotnet/extensions/issues/7790
        (choices ??= data.choices.slice())[index] = { ...choice, delta: {} };
      } else if (!isJsonObject(choice.delta)) {
        yield invalid(`${field}.delta`, 'an object', choice.delta);
        return;
      }
    }
    yield { ok: true, value: choices === undefined ? data : { ...data, choices } };
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
