import type { MessagesStreamEvent } from './index.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';

export interface ParseMessagesStreamOptions {
  signal?: AbortSignal;
}

export const parseMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<MessagesStreamEvent>(parseSSEStream(body, options), {
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
