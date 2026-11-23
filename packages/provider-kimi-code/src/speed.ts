import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// In observed chat requests Kimi accepted priority without a response tier marker
// and rejected fast. Messages accepted fast without a usage speed marker. Expose
// the catalog lane selected by Floway when the upstream omits its marker.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://developers.openai.com/api/docs/guides/priority-processing
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const withKimiCodeChatTier = (event: OpenAIChatCompletionsStreamEvent, tier: 'priority' | 'default'): OpenAIChatCompletionsStreamEvent =>
  ({ ...event, service_tier: tier });

export const withKimiCodeResponsesTier = (event: OpenAIResponsesStreamEventEx, tier: 'priority' | 'default'): OpenAIResponsesStreamEventEx =>
  'response' in event ? { ...event, response: { ...event.response, service_tier: tier } } : event;

export const withKimiCodeMessagesSpeed = (event: AnthropicMessagesStreamEventEx, speed: 'fast' | 'standard'): AnthropicMessagesStreamEventEx =>
  event.type === 'message_start' ? { ...event, message: { ...event.message, usage: { ...event.message.usage, speed } } } : event;

export const kimiCodeMessagesWireBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (body.speed !== 'fast' && body.speed !== 'standard') return body;
  const { speed: _speed, ...wireBody } = body;
  return wireBody;
};
