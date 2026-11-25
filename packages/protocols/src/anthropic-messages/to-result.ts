import type { AnthropicMessagesResult, AnthropicMessagesStreamEventEx } from './index.ts';
import { createAnthropicMessagesEventAccumulator } from './reassemble.ts';
import type { ParsedProtocolFrame, SseErrorFrame } from '../common/sse.ts';
import type { Result } from '@floway-dev/pipeline';

export const ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Anthropic Messages stream ended without a message_stop event.';

export const collectAnthropicMessagesProtocolEventsToResult = async (frames: AsyncIterable<ParsedProtocolFrame<AnthropicMessagesStreamEventEx>>): Promise<Result<AnthropicMessagesResult, SseErrorFrame>> => {
  const accumulator = createAnthropicMessagesEventAccumulator();
  for await (const frame of frames) {
    if (frame.type === 'error') return { ok: false, error: frame };
    if (frame.type === 'done') continue;
    const failure = accumulator.accept(frame.event);
    if (failure !== undefined) return { ok: false, error: failure };
    if (frame.event.type === 'message_stop') return accumulator.result();
  }
  const cause = new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
  return { ok: false, error: { type: 'error', cause } };
};
