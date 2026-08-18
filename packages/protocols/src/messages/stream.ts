import type { MessagesStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../common/sse.ts';

export interface ParseMessagesStreamOptions {
  signal?: AbortSignal;
  onSseFrame?: (frame: SseFrame) => void;
}

export const parseMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> => (async function* () {
  const rawFrames = (async function* () {
    for await (const frame of parseSSEStream(body, options)) {
      options.onSseFrame?.(frame);
      yield frame;
    }
  })();
  for await (const frame of parseTargetStreamFrames<MessagesStreamEvent>(rawFrames, {
    protocol: 'Messages',
    malformedJsonEventName: 'message',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
      return;
    }
    yield eventFrame(frame.data);
  }
})();
