import type { AnthropicMessagesStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseAnthropicMessagesStreamOptions {
  signal?: AbortSignal;
}

export const parseAnthropicMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseAnthropicMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<AnthropicMessagesStreamEvent>(parseSSEStream(body, options), {
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
