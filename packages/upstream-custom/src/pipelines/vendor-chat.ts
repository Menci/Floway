import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/upstream';

const summaryParts = (items: unknown): string[] => {
  const parts: string[] = [];
  if (!Array.isArray(items)) return parts;
  for (const item of items) {
    if (!isJsonObject(item) || !Array.isArray(item.summary)) continue;
    for (const part of item.summary) {
      if (isJsonObject(part) && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts;
};

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/guides/kv_cache
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
const deepSeekMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const assistant: OpenAIChatCompletionsAssistantMessageEx = message;
  if (!('reasoning_text' in assistant || 'reasoning_opaque' in assistant || 'reasoning_items' in assistant)) return message;
  const { reasoning_text: reasoning, reasoning_opaque: _opaque, reasoning_items: items, ...rest } = assistant;
  const summary = summaryParts(items);
  const text = typeof reasoning === 'string' ? reasoning : summary.length > 0 ? summary.join('') : undefined;
  if (text === undefined) return rest;
  const replay = { ...rest, reasoning_content: text };
  return replay;
};

const deepSeekChatRequest = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const messages = payload.messages.map(deepSeekMessage);
  let normalized = messages.some((message, index) => message !== payload.messages[index]) ? { ...payload, messages } : payload;
  if (normalized.reasoning_effort === 'none') {
    const { reasoning_effort: _effort, ...rest } = normalized;
    const wire = { ...rest, thinking: { type: 'disabled' } };
    normalized = wire;
  }
  return normalized.response_format?.type === 'json_schema' ? { ...normalized, response_format: { type: 'json_object' } } : normalized;
};

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
export const normalizeChatRequest = (payload: OpenAIChatCompletionsPayloadEx, flags: readonly FlagId[]): OpenAIChatCompletionsPayloadEx => {
  const normalized = flags.includes('vendor-deepseek') ? deepSeekChatRequest(payload) : payload;
  if (!flags.includes('vendor-qwen') || normalized.reasoning_effort !== 'none') return normalized;
  const { reasoning_effort: _effort, ...rest } = normalized;
  const wire = { ...rest, enable_thinking: false };
  return wire;
};

export const normalizeResponsesRequest = (payload: CanonicalOpenAIResponsesPayload, flags: readonly FlagId[]): CanonicalOpenAIResponsesPayload => {
  if (payload.reasoning?.effort !== 'none') return payload;
  const { reasoning: _reasoning, ...rest } = payload;
  if (flags.includes('vendor-deepseek')) {
    const wire = { ...rest, thinking: { type: 'disabled' } };
    return wire;
  }
  if (flags.includes('vendor-qwen')) {
    const wire = { ...rest, enable_thinking: false };
    return wire;
  }
  return payload;
};

const deepSeekDeltas = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const choices = chunk.choices.map(choice => {
    const { delta } = choice;
    if (!('reasoning_content' in delta) || typeof delta.reasoning_content !== 'string') return choice;
    const { reasoning_content: content, ...rest } = delta;
    const reasoning = 'reasoning_text' in delta ? delta.reasoning_text : undefined;
    const rewritten = { ...rest, ...(reasoning === undefined ? { reasoning_text: content } : {}) };
    return { ...choice, delta: rewritten };
  });
  return choices.some((choice, index) => choice !== chunk.choices[index]) ? { ...chunk, choices } : chunk;
};

type VendorUsage = NonNullable<OpenAIChatCompletionsStreamEvent['usage']> & {
  cached_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
};

// https://platform.kimi.com/docs/api/chat
export const normalizeChatEvent = (chunk: OpenAIChatCompletionsStreamEvent, deepSeek: boolean, kimi: boolean): OpenAIChatCompletionsStreamEvent => {
  const normalized = deepSeek ? deepSeekDeltas(chunk) : chunk;
  const usage: VendorUsage | null | undefined = normalized.usage;
  if (!isJsonObject(usage)) return normalized;
  const cached: unknown = usage.cached_tokens;
  const hit: unknown = usage.prompt_cache_hit_tokens;
  const miss: unknown = usage.prompt_cache_miss_tokens;
  const kimiCached = kimi && typeof cached === 'number';
  const deepSeekUsage = deepSeek && (hit !== undefined || miss !== undefined);
  if (!kimiCached && !deepSeekUsage) return normalized;
  const updated = { ...usage };
  if (kimiCached) delete updated.cached_tokens;
  if (deepSeekUsage) {
    delete updated.prompt_cache_hit_tokens;
    delete updated.prompt_cache_miss_tokens;
  }
  const count = deepSeek && typeof hit === 'number' ? hit : kimiCached ? cached : undefined;
  if (count !== undefined) {
    const details = updated.prompt_tokens_details;
    updated.prompt_tokens_details = { ...(isJsonObject(details) ? details : {}), cached_tokens: count };
  }
  return { ...normalized, usage: updated };
};
