import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// https://platform.kimi.com/docs/api/chat
export const fromKimiChatCompletions = (event: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  if (!isJsonObject(event.usage)) return event;
  const wire: typeof event.usage & { cached_tokens?: unknown } = event.usage;
  const { cached_tokens: cached, ...usage } = wire;
  if (typeof cached !== 'number') return event;
  const details = usage.prompt_tokens_details;
  return {
    ...event,
    usage: { ...usage, prompt_tokens_details: { ...(isJsonObject(details) ? details : {}), cached_tokens: cached } },
  };
};
