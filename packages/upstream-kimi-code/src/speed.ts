import type { KimiCodeMessagesSpeed, KimiCodeOpenAITier } from './model-selection.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

// In observed chat requests Kimi accepted priority without a response tier marker
// and rejected fast. Messages accepted fast without a usage speed marker. Expose
// the catalog lane selected by Floway when the upstream omits its marker.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://developers.openai.com/api/docs/guides/priority-processing
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const setKimiCodeChatCompletionsTier = (event: OpenAIChatCompletionsStreamEvent, tier: KimiCodeOpenAITier): OpenAIChatCompletionsStreamEvent => ({ ...event, service_tier: tier });

export const setKimiCodeResponsesTier = (event: OpenAIResponsesStreamEventEx, tier: KimiCodeOpenAITier): OpenAIResponsesStreamEventEx => 'response' in event
  ? { ...event, response: { ...event.response, service_tier: tier } }
  : event;

export const setKimiCodeMessagesSpeed = (event: AnthropicMessagesStreamEventEx, speed: KimiCodeMessagesSpeed): AnthropicMessagesStreamEventEx => event.type === 'message_start'
  ? { ...event, message: { ...event.message, usage: { ...event.message.usage, speed } } }
  : event;

export const kimiCodeMessagesWireBody = <Body extends { speed?: unknown }>(body: Body): Omit<Body, 'speed'> & { speed?: unknown } => {
  if (body.speed !== 'fast' && body.speed !== 'standard') return body;
  const { speed: _speed, ...wireBody } = body;
  return wireBody;
};
