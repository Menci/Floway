import { factSpace } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsReasoningItemEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/guides/kv_cache
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
export const normalizeDeepSeek = defineStage({
  name: 'azure.openaiChatCompletions.normalize-deepseek',
  through: {
    request: { needs: ['provider.model', 'request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts['provider.model'].enabledFlags.includes('vendor-deepseek')) return await scope.next(facts);
    const request = facts['request.openaiChatCompletions'];
    const payload = normalizeRequest(request);
    const back = await scope.next(payload === request ? facts : { ...facts, 'request.openaiChatCompletions': payload });
    const outcome = back['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') return back;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const value = normalizeUsage(normalizeDeltas(item.value));
        yield value === item.value ? item : { ok: true, value };
      }
    });
    return { ...back, 'response.openaiChatCompletions': { ...outcome, stream } };
  },
});

const normalizeMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const assistant = message as OpenAIChatCompletionsAssistantMessageEx;
  if (!('reasoning_text' in assistant || 'reasoning_opaque' in assistant || 'reasoning_items' in assistant)) return message;
  const { reasoning_text: reasoning, reasoning_opaque: _opaque, reasoning_items: items, ...rest } = assistant;
  if (typeof reasoning === 'string') return { ...rest, reasoning_content: reasoning } as OpenAIChatCompletionsMessage;
  const parts = (items as OpenAIChatCompletionsReasoningItemEx[] | null | undefined)?.flatMap(item => item.summary?.map(part => part.text) ?? []);
  return parts?.length ? { ...rest, reasoning_content: parts.join('') } as OpenAIChatCompletionsMessage : rest;
};

const normalizeRequest = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const messages = payload.messages.map(normalizeMessage);
  let normalized = messages.some((message, index) => message !== payload.messages[index]) ? { ...payload, messages } : payload;
  if (normalized.reasoning_effort === 'none') {
    const { reasoning_effort: _effort, ...rest } = normalized;
    normalized = { ...rest, thinking: { type: 'disabled' } } as OpenAIChatCompletionsPayloadEx;
  }
  return normalized.response_format?.type === 'json_schema'
    ? { ...normalized, response_format: { type: 'json_object' } }
    : normalized;
};

const normalizeDeltas = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const choices = chunk.choices.map(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
    if (typeof delta.reasoning_content !== 'string') return choice;
    const { reasoning_content: content, ...rest } = delta;
    return {
      ...choice,
      delta: { ...rest, ...(delta.reasoning_text === undefined && { reasoning_text: content }) },
    };
  });
  return choices.some((choice, index) => choice !== chunk.choices[index]) ? { ...chunk, choices } : chunk;
};

const normalizeUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const raw: unknown = chunk.usage;
  if (!isJsonObject(raw)) return chunk;
  const { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, ...rest } = raw;
  if (hit === undefined && miss === undefined) return chunk;
  const usage = typeof hit === 'number'
    ? { ...rest, prompt_tokens_details: { ...(isJsonObject(rest.prompt_tokens_details) ? rest.prompt_tokens_details : {}), cached_tokens: hit } }
    : rest;
  return { ...chunk, usage: usage as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
};
