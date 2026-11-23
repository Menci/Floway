import { asJsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { mapProtocolEvents, rewriteChatFrames } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// DeepSeek exposes the cache hit length as prompt_cache_hit_tokens. The miss count has no separate OpenAI field.
// https://api-docs.deepseek.com/guides/kv_cache
const normalizeDeepSeekUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const { usage } = chunk;
  if (!usage || !asJsonObject(usage)) return chunk;
  const {
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    ...remaining
  } = usage as typeof usage & { prompt_cache_hit_tokens?: unknown; prompt_cache_miss_tokens?: unknown };
  if (hit === undefined && miss === undefined) return chunk;
  const cacheRead = readJsonNumber(hit);
  return {
    ...chunk,
    usage: cacheRead === null ? remaining : {
      ...remaining,
      prompt_tokens_details: { ...asJsonObject(usage.prompt_tokens_details), cached_tokens: cacheRead },
    },
  };
};

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
const normalizeDeepSeekDeltas = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  let changed = false;
  const choices = chunk.choices.map(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
    if (typeof delta.reasoning_content !== 'string') return choice;

    const { reasoning_content: thinking, ...rest } = delta;
    changed = true;
    return {
      ...choice,
      delta: { ...rest, ...(delta.reasoning_text === undefined ? { reasoning_text: thinking } : {}) },
    };
  });
  return changed ? { ...chunk, choices } : chunk;
};

export const normalizeDeepSeekResponse = rewriteChatFrames(
  'normalizeDeepSeekResponse', 'response.events', ({ 'route.candidate': { providerModel } }) => providerModel.enabledFlags.includes('vendor-deepseek')
    ? mapProtocolEvents<OpenAIChatCompletionsStreamEvent>(event => normalizeDeepSeekUsage(normalizeDeepSeekDeltas(event)))
    : undefined,
);
