import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import type { ProviderStreamParser } from '@floway-dev/provider';

const mapParser = <T>(parser: ProviderStreamParser<T>, map: (event: T) => T): ProviderStreamParser<T> => async function* (body, options) {
  for await (const frame of parser(body, options)) yield frame.type === 'event' ? eventFrame(map(frame.event)) : frame;
};

// In observed chat requests Kimi accepted priority without a response tier marker
// and rejected fast. Messages accepted fast without a usage speed marker. Expose
// the catalog lane selected by Floway when the upstream omits its marker.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://developers.openai.com/api/docs/guides/priority-processing
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const kimiCodeChatSpeedParser = (tier: 'priority' | 'default') => mapParser(parseOpenAIChatCompletionsStream, event => ({ ...event, service_tier: tier }));

export const kimiCodeResponsesSpeedParser = (tier: 'priority' | 'default') => mapParser(parseOpenAIResponsesStream, event => 'response' in event ? { ...event, response: { ...event.response, service_tier: tier } } : event);

export const kimiCodeMessagesSpeedParser = (speed: 'fast' | 'standard') => mapParser(parseAnthropicMessagesStream, event => event.type === 'message_start'
  ? { ...event, message: { ...event.message, usage: { ...event.message.usage, speed } } }
  : event);

export const kimiCodeMessagesWireBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (body.speed !== 'fast' && body.speed !== 'standard') return body;
  const { speed: _speed, ...wireBody } = body;
  return wireBody;
};
