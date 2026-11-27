import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const summarizeReasoning = (items: unknown): string | undefined => {
  if (!Array.isArray(items)) return undefined;
  const summaries = items.flatMap((item: unknown) =>
    isJsonObject(item) && Array.isArray(item.summary)
      ? item.summary.flatMap((part: unknown) => isJsonObject(part) && typeof part.text === 'string' ? [part.text] : [])
      : []);
  return summaries.length === 0 ? undefined : summaries.join('');
};

const normalizeMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant' || !isJsonObject(message)) return message;
  if (!('reasoning_text' in message || 'reasoning_opaque' in message || 'reasoning_items' in message)) return message;
  const assistant: typeof message & { reasoning_text?: unknown; reasoning_opaque?: unknown; reasoning_items?: unknown } = message;
  const { reasoning_text: reasoning, reasoning_opaque: _opaque, reasoning_items: items, ...rest } = assistant;
  const text = typeof reasoning === 'string' ? reasoning : summarizeReasoning(items);
  const wire = { ...rest, reasoning_content: text };
  return text === undefined ? rest : wire;
};

// https://api-docs.deepseek.com/guides/thinking_mode
// https://api-docs.deepseek.com/guides/json_mode
export const toDeepSeekChatCompletions = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const messages = payload.messages.map(normalizeMessage);
  let wire = messages.some((message, index) => message !== payload.messages[index]) ? { ...payload, messages } : payload;
  if (wire.reasoning_effort === 'none') {
    const { reasoning_effort: _effort, ...rest } = wire;
    const disabled = { ...rest, thinking: { type: 'disabled' } };
    wire = disabled;
  }
  return wire.response_format?.type === 'json_schema' ? { ...wire, response_format: { type: 'json_object' } } : wire;
};

const normalizeDeltas = (event: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const choices = event.choices.map(choice => {
    if (!isJsonObject(choice.delta)) return choice;
    const wire: typeof choice.delta & { reasoning_content?: unknown; reasoning_text?: unknown } = choice.delta;
    const { reasoning_content: text, ...delta } = wire;
    if (typeof text !== 'string') return choice;
    return { ...choice, delta: { ...delta, ...(delta.reasoning_text === undefined ? { reasoning_text: text } : {}) } };
  });
  return choices.some((choice, index) => choice !== event.choices[index]) ? { ...event, choices } : event;
};

// https://api-docs.deepseek.com/guides/kv_cache
const normalizeUsage = (event: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  if (!isJsonObject(event.usage)) return event;
  const wire: typeof event.usage & { prompt_cache_hit_tokens?: unknown; prompt_cache_miss_tokens?: unknown } = event.usage;
  const { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, ...usage } = wire;
  if (hit === undefined && miss === undefined) return event;
  if (typeof hit !== 'number') return { ...event, usage };
  const details = usage.prompt_tokens_details;
  return {
    ...event,
    usage: { ...usage, prompt_tokens_details: { ...(isJsonObject(details) ? details : {}), cached_tokens: hit } },
  };
};

export const fromDeepSeekChatCompletions = (event: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => normalizeUsage(normalizeDeltas(event));
