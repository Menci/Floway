import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const withoutSystem = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const { system: _system, ...rest } = payload;
  return rest;
};
