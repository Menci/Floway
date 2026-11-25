import type { AnthropicMessagesStreamEventEx } from './index.ts';
import { ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE } from './to-result.ts';
import { decodeSseEvents, protocolDecodeError, type ProtocolByteStream, type ProtocolEventStream } from '../common/decode-sse-events.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../common/sse.ts';

export interface ParseAnthropicMessagesStreamOptions {
  signal?: AbortSignal | undefined;
  onSseFrame?: (frame: SseFrame) => void;
}

export const decodeAnthropicMessagesStream = async function* <Failure>(
  body: ProtocolByteStream<Failure>,
): ProtocolEventStream<AnthropicMessagesStreamEventEx, Failure> {
  let ended = false;
  for await (const item of decodeSseEvents<AnthropicMessagesStreamEventEx, Failure>(body, {
    protocol: 'Anthropic Messages', malformedJsonEventName: 'message', ignoreEvents: () => ended,
  })) {
    if (!item.ok) {
      yield item;
      return;
    }
    const { data: event, eventName } = item.value;
    ended = event.type === 'error' || eventName === 'error' || event.type === 'message_stop';
    yield { ok: true, value: event };
  }
  if (!ended) yield protocolDecodeError(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

export const parseAnthropicMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseAnthropicMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> => (async function* () {
  const rawFrames = (async function* () {
    for await (const frame of parseSSEStream(body, options)) {
      if (frame.type === 'sse') options.onSseFrame?.(frame);
      yield frame;
    }
  })();
  for await (const frame of parseTargetStreamFrames<AnthropicMessagesStreamEventEx>(rawFrames, {
    protocol: 'Anthropic Messages',
    malformedJsonEventName: 'message',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
