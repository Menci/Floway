import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const mapEvents = async function* <T>(frames: AsyncIterable<ProtocolFrame<T>>, map: (event: T) => T): AsyncGenerator<ProtocolFrame<T>> {
  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame;
      continue;
    }
    const event = map(frame.event);
    yield event === frame.event ? frame : eventFrame(event);
  }
};

// In observed chat requests Kimi accepted priority without a response tier marker
// and rejected fast. Messages accepted fast without a usage speed marker. Expose
// the catalog lane selected by Floway when the upstream omits its marker.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://developers.openai.com/api/docs/guides/priority-processing
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const kimiCodeChatSpeed = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, tier: 'priority' | 'default') =>
  mapEvents(frames, event => ({ ...event, service_tier: tier }));

export const kimiCodeResponsesSpeed = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, tier: 'priority' | 'default') =>
  mapEvents(frames, event => 'response' in event ? { ...event, response: { ...event.response, service_tier: tier } } : event);

export const kimiCodeMessagesSpeed = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, speed: 'fast' | 'standard') => mapEvents(frames, event => event.type === 'message_start'
  ? { ...event, message: { ...event.message, usage: { ...event.message.usage, speed } } }
  : event);

export const kimiCodeMessagesWireBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (body.speed !== 'fast' && body.speed !== 'standard') return body;
  const { speed: _speed, ...wireBody } = body;
  return wireBody;
};
