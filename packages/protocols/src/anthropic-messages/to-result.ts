import type { AnthropicMessagesResult, AnthropicMessagesStreamEventEx } from './index.ts';
import { reassembleAnthropicMessagesEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';

export const ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Anthropic Messages stream ended without a message_stop event.';

const anthropicMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): AsyncGenerator<AnthropicMessagesStreamEventEx> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') return;
  }

  throw new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

export const collectAnthropicMessagesProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): Promise<AnthropicMessagesResult> => {
  return await reassembleAnthropicMessagesEvents(anthropicMessagesEventsUntilTerminal(frames));
};
