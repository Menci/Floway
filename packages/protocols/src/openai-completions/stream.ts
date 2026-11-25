import type { OpenAICompletionsStreamEvent } from './index.ts';
import { isOpenAIErrorPayload } from '../common/openai-error.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { eventFrame, type ParsedProtocolFrame } from '../common/sse.ts';

export const parseOpenAICompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal | undefined } = {},
): AsyncGenerator<ParsedProtocolFrame<OpenAICompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<OpenAICompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'openaiCompletions',
  })) {
    if (frame.type === 'done' || frame.type === 'error') {
      yield frame;
      return;
    }
    if (isOpenAIErrorPayload(frame.data)) {
      yield { type: 'error', cause: { message: frame.data.error.message, cause: frame.data } };
      return;
    }
    yield eventFrame(frame.data);
  }
})();
