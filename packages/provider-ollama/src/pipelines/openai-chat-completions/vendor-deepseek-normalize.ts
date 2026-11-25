import { vendorStage } from './vendor-stage.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsReasoningItemEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/guides/kv_cache
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
export const normalizeDeepSeek = vendorStage('vendor-deepseek', rewriteRequest, rewriteChunk);

function rewriteRequest(payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx {
  let next = payload;
  if (next.reasoning_effort === 'none') {
    const { reasoning_effort: _effort, ...rest } = next;
    const shaped = { ...rest, thinking: { type: 'disabled' } };
    next = shaped;
  }
  if (next.response_format?.type === 'json_schema') next = { ...next, response_format: { type: 'json_object' } };
  const messages = next.messages.map(rewriteMessage);
  return messages.some((message, index) => message !== next.messages[index]) ? { ...next, messages } : next;
}

function rewriteMessage(message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage {
  if (message.role !== 'assistant') return message;
  const { reasoning_text, reasoning_opaque, reasoning_items, ...rest } = message as OpenAIChatCompletionsAssistantMessageEx;
  if (reasoning_text === undefined && reasoning_opaque === undefined && reasoning_items === undefined) return message;
  // DeepSeek requires reasoning_content on replayed tool calls.
  const items = reasoning_items as OpenAIChatCompletionsReasoningItemEx[] | null | undefined;
  const parts = items?.flatMap(item => item.summary?.map(part => part.text) ?? []) ?? [];
  const text = typeof reasoning_text === 'string' ? reasoning_text : (parts.length > 0 ? parts.join('') : undefined);
  const shaped = text === undefined ? rest : { ...rest, reasoning_content: text };
  return shaped as OpenAIChatCompletionsMessage;
}

function rewriteChunk(chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent {
  const choices = chunk.choices.map(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
    const { reasoning_content, ...rest } = delta;
    return typeof reasoning_content === 'string'
      ? { ...choice, delta: { ...rest, ...(delta.reasoning_text === undefined && { reasoning_text: reasoning_content }) } }
      : choice;
  });
  const next = choices.some((choice, index) => choice !== chunk.choices[index]) ? { ...chunk, choices } : chunk;
  const usage: unknown = next.usage;
  if (!isJsonObject(usage)) return next;
  const { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, ...rest } = usage;
  if (hit === undefined && miss === undefined) return next;
  const normalized = typeof hit === 'number'
    ? { ...rest, prompt_tokens_details: { ...(isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}), cached_tokens: hit } }
    : rest;
  return { ...next, usage: normalized as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
}
