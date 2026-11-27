import { defineStage } from '../facts.ts';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsReasoningItemEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { FlagId } from '@floway-dev/upstream';

// https://api-docs.deepseek.com/guides/thinking_mode
// https://api-docs.deepseek.com/guides/json_mode
const deepSeekChatRequest = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  let next = payload;
  if (next.reasoning_effort === 'none') {
    const { reasoning_effort: _effort, ...rest } = next;
    const shaped = { ...rest, thinking: { type: 'disabled' } };
    next = shaped;
  }
  if (next.response_format?.type === 'json_schema') next = { ...next, response_format: { type: 'json_object' } };
  const messages = next.messages.map(deepSeekMessage);
  return messages.some((message, index) => message !== next.messages[index]) ? { ...next, messages } : next;
};

// DeepSeek requires reasoning_content on replayed tool calls.
// https://api-docs.deepseek.com/guides/thinking_mode
const deepSeekMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const { reasoning_text, reasoning_opaque, reasoning_items, ...rest } = message as OpenAIChatCompletionsAssistantMessageEx;
  if (reasoning_text === undefined && reasoning_opaque === undefined && reasoning_items === undefined) return message;
  const items = reasoning_items as OpenAIChatCompletionsReasoningItemEx[] | null | undefined;
  const parts = items?.flatMap(item => item.summary?.map(part => part.text) ?? []) ?? [];
  const text = typeof reasoning_text === 'string' ? reasoning_text : (parts.length > 0 ? parts.join('') : undefined);
  const shaped = text === undefined ? rest : { ...rest, reasoning_content: text };
  return shaped as OpenAIChatCompletionsMessage;
};

type ChatChunk = OpenAIChatCompletionsStreamEvent;
const withCacheHit = (usage: JsonObject, hit: number): JsonObject => ({
  ...usage,
  prompt_tokens_details: { ...(isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}), cached_tokens: hit },
});

// https://api-docs.deepseek.com/guides/kv_cache
const deepSeekChatEvent = (chunk: ChatChunk): ChatChunk => {
  const choices = chunk.choices.map(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
    const { reasoning_content, ...rest } = delta;
    return typeof reasoning_content === 'string'
      ? { ...choice, delta: { ...rest, ...(delta.reasoning_text === undefined && { reasoning_text: reasoning_content }) } }
      : choice;
  });
  const next = choices.some((choice, index) => choice !== chunk.choices[index]) ? { ...chunk, choices } : chunk;
  const wireUsage: unknown = next.usage;
  if (!isJsonObject(wireUsage)) return next;
  const { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, ...rest } = wireUsage;
  if (hit === undefined && miss === undefined) return next;
  const usage = typeof hit === 'number' ? withCacheHit(rest, hit) : rest;
  return { ...next, usage: usage as unknown as NonNullable<ChatChunk['usage']> };
};

// https://platform.kimi.com/docs/api/chat
const kimiChatEvent = (chunk: ChatChunk): ChatChunk => {
  const wireUsage: unknown = chunk.usage;
  if (!isJsonObject(wireUsage)) return chunk;
  const { cached_tokens: hit, ...rest } = wireUsage;
  if (typeof hit !== 'number') return chunk;
  return { ...chunk, usage: withCacheHit(rest, hit) as unknown as NonNullable<ChatChunk['usage']> };
};

// https://www.alibabacloud.com/help/en/model-studio/deep-thinking
const qwenChatRequest = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _effort, ...rest } = payload;
  const shaped = { ...rest, enable_thinking: false };
  return shaped;
};

// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/chatcompletionrequest.py
const MISTRAL_REQUEST_FIELDS = [
  'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stream', 'stop', 'random_seed',
  'response_format', 'tools', 'tool_choice', 'presence_penalty', 'frequency_penalty', 'min_tokens',
  'repetition_penalty', 'top_k', 'logprobs', 'top_logprobs', 'prompt_logprobs', 'top_prompt_logprobs', 'n',
  'prediction', 'parallel_tool_calls', 'reasoning_effort', 'prompt_mode', 'guardrails', 'prompt_cache_key',
  'service_tier', 'safe_prompt',
] as const;

// https://github.com/mistralai/client-python/tree/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models
const MISTRAL_MESSAGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  system: ['role', 'content'],
  user: ['role', 'content'],
  assistant: ['role', 'content', 'tool_calls', 'prefix'],
  tool: ['role', 'content', 'tool_call_id', 'name'],
};

const pickMistralFields = (source: JsonObject, keys: readonly string[]): JsonObject =>
  Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));

// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/toolcall.py
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/functioncall.py
const mistralToolCall = (value: unknown): unknown => {
  if (!isJsonObject(value)) return value;
  const toolCall = pickMistralFields(value, ['id', 'type', 'function', 'index']);
  return isJsonObject(toolCall.function) ? { ...toolCall, function: pickMistralFields(toolCall.function, ['name', 'arguments']) } : toolCall;
};

const mistralMessage = (value: unknown): unknown => {
  if (!isJsonObject(value) || typeof value.role !== 'string' || !Object.hasOwn(MISTRAL_MESSAGE_FIELDS, value.role)) return value;
  const message = pickMistralFields(value, MISTRAL_MESSAGE_FIELDS[value.role]!);
  return value.role === 'assistant' && Array.isArray(message.tool_calls) ? { ...message, tool_calls: message.tool_calls.map(mistralToolCall) } : message;
};

// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/tool.py
// https://github.com/mistralai/client-python/blob/d3da3bd3c63d0502449e1e765bc2d3c16d0d2f1d/src/mistralai/client/models/function.py
const mistralTool = (value: unknown): unknown => {
  if (!isJsonObject(value)) return value;
  const tool = pickMistralFields(value, ['type', 'function']);
  return isJsonObject(tool.function) ? { ...tool, function: pickMistralFields(tool.function, ['name', 'description', 'parameters', 'strict']) } : tool;
};

const mistralChatRequest = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const request = pickMistralFields(payload as unknown as JsonObject, MISTRAL_REQUEST_FIELDS);
  if (payload.max_tokens === undefined && payload.max_completion_tokens !== undefined) request.max_tokens = payload.max_completion_tokens;
  if (Array.isArray(request.messages)) request.messages = request.messages.map(mistralMessage);
  if (Array.isArray(request.tools)) request.tools = request.tools.map(mistralTool);
  if (isJsonObject(payload.stream_options) && payload.stream_options.include_usage !== undefined) request.stream_options = { include_usage: payload.stream_options.include_usage };
  return request as unknown as OpenAIChatCompletionsPayloadEx;
};

const normalizeChatRequest = (payload: OpenAIChatCompletionsPayloadEx, flags: readonly FlagId[]): OpenAIChatCompletionsPayloadEx => {
  let next = payload;
  if (flags.includes('vendor-deepseek')) next = deepSeekChatRequest(next);
  if (flags.includes('vendor-qwen')) next = qwenChatRequest(next);
  if (flags.includes('vendor-mistral')) next = mistralChatRequest(next);
  return next;
};

export const normalizeChatCompletions = defineStage({
  name: 'ollama.openaiChatCompletions.vendor-normalization',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const flags = facts.model.enabledFlags;
    const payload = normalizeChatRequest(facts.openaiChatCompletions, flags);
    const answer = await scope.next(payload === facts.openaiChatCompletions ? facts : { ...facts, openaiChatCompletions: payload });
    const outcome = answer.openaiChatCompletions;
    const kimi = flags.includes('vendor-kimi');
    const deepSeek = flags.includes('vendor-deepseek');
    if (outcome.kind !== 'stream' || (!kimi && !deepSeek)) return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const kimiEvent = kimi ? kimiChatEvent(item.value) : item.value;
        const value = deepSeek ? deepSeekChatEvent(kimiEvent) : kimiEvent;
        yield value === item.value ? item : { ok: true, value };
      }
    });
    return { ...answer, openaiChatCompletions: { ...outcome, stream } };
  },
});
