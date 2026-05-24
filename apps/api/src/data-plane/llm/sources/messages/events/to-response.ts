import { reassembleMessagesEvents } from './reassemble.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesResponse, MessagesStreamEventData } from '@floway-dev/protocols/messages';

export const MESSAGES_MISSING_TERMINAL_MESSAGE = 'Messages stream ended without a message_stop event.';

const isMessagesTerminalEvent = (event: Pick<MessagesStreamEventData, 'type'>): boolean => event.type === 'message_stop' || event.type === 'error';

const messagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<MessagesStreamEventData> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (isMessagesTerminalEvent(frame.event)) return;
  }

  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

export const collectMessagesProtocolEventsToResponse = async (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): Promise<MessagesResponse> => {
  return await reassembleMessagesEvents(messagesEventsUntilTerminal(frames));
};
