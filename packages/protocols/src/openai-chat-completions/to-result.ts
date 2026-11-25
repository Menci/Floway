import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResultEx } from './index.ts';
import { createOpenAIChatCompletionsEventAccumulator } from './reassemble.ts';
import type { ParsedProtocolFrame, SseErrorFrame } from '../common/sse.ts';
import type { Result } from '@floway-dev/pipeline';

export const collectOpenAIChatCompletionsProtocolEventsToResult = async (frames: AsyncIterable<ParsedProtocolFrame<OpenAIChatCompletionsStreamEvent>>): Promise<Result<OpenAIChatCompletionsResultEx, SseErrorFrame>> => {
  const accumulator = createOpenAIChatCompletionsEventAccumulator();
  for await (const frame of frames) {
    if (frame.type === 'error') return { ok: false, error: frame };
    if (frame.type === 'done') break;
    const failure = accumulator.accept(frame.event);
    if (failure !== undefined) return { ok: false, error: failure };
  }
  return accumulator.result();
};
