import { defineStage } from '../facts.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const normalizeOpenAIChatCompletionsVendor = defineStage({
  name: 'kimi-code.openaiChatCompletions.normalize-vendor',
  through: {
    request: { needs: ['model', 'openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    const { enabledFlags } = facts.model;
    const deepSeek = enabledFlags.includes('vendor-deepseek');
    const kimi = enabledFlags.includes('vendor-kimi');
    let payload = facts.openaiChatCompletions;
    if (deepSeek) payload = deepSeekRequest(payload);
    if (enabledFlags.includes('vendor-qwen') && payload.reasoning_effort === 'none') {
      const { reasoning_effort: _effort, ...rest } = payload;
      // https://www.alibabacloud.com/help/en/model-studio/deep-thinking
      const wire = { ...rest, enable_thinking: false };
      payload = wire;
    }
    const answer = await scope.next({ ...facts, openaiChatCompletions: payload });
    const outcome = answer.openaiChatCompletions;
    if (outcome.kind !== 'stream' || (!deepSeek && !kimi)) return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) {
          yield item;
          continue;
        }
        const event = deepSeek ? normalizeDeepSeekDeltas(item.value) : item.value;
        yield { ok: true, value: normalizeUsage(event, deepSeek, kimi) };
      }
    });
    return { ...answer, openaiChatCompletions: { kind: 'stream', stream } };
  },
});

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
function deepSeekRequest(payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx {
  let wire = { ...payload, messages: payload.messages.map(deepSeekMessage) };
  if (wire.reasoning_effort === 'none') {
    const { reasoning_effort: _effort, ...rest } = wire;
    const disabled = { ...rest, thinking: { type: 'disabled' } };
    wire = disabled;
  }
  return wire.response_format?.type === 'json_schema' ? { ...wire, response_format: { type: 'json_object' } } : wire;
}

function deepSeekMessage(message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage {
  if (message.role !== 'assistant') return message;
  const assistant: OpenAIChatCompletionsAssistantMessageEx = message;
  const { reasoning_text: reasoning, reasoning_opaque: _opaque, reasoning_items: items, ...rest } = assistant;
  if (typeof reasoning === 'string') {
    const replay = { ...rest, reasoning_content: reasoning };
    return replay;
  }
  const parts: string[] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isJsonObject(item) || !Array.isArray(item.summary)) continue;
      for (const part of item.summary) {
        if (isJsonObject(part) && typeof part.text === 'string') parts.push(part.text);
      }
    }
  }
  if (parts.length === 0) return rest;
  const replay = { ...rest, reasoning_content: parts.join('') };
  return replay;
}

function normalizeDeepSeekDeltas(event: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent {
  const choices = event.choices.map(choice => {
    const { delta } = choice;
    if (!('reasoning_content' in delta) || typeof delta.reasoning_content !== 'string') return choice;
    const { reasoning_content: reasoning, ...rest } = delta;
    const text = 'reasoning_text' in delta ? delta.reasoning_text : undefined;
    const updated = { ...rest, ...(text === undefined && { reasoning_text: reasoning }) };
    return { ...choice, delta: updated };
  });
  return { ...event, choices };
}

type VendorUsage = NonNullable<OpenAIChatCompletionsStreamEvent['usage']> & {
  cached_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
};

// https://api-docs.deepseek.com/guides/kv_cache
// https://platform.kimi.com/docs/api/chat
function normalizeUsage(event: OpenAIChatCompletionsStreamEvent, deepSeek: boolean, kimi: boolean): OpenAIChatCompletionsStreamEvent {
  const usage: VendorUsage | null | undefined = event.usage;
  if (!isJsonObject(usage)) return event;
  const { cached_tokens: cached, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, prompt_tokens_details: details } = usage;
  const kimiCached = kimi && typeof cached === 'number';
  const deepSeekUsage = deepSeek && (hit !== undefined || miss !== undefined);
  if (!kimiCached && !deepSeekUsage) return event;
  const updated = { ...usage };
  if (kimiCached) delete updated.cached_tokens;
  if (deepSeekUsage) {
    delete updated.prompt_cache_hit_tokens;
    delete updated.prompt_cache_miss_tokens;
  }
  const count = deepSeek && typeof hit === 'number' ? hit : kimiCached ? cached : undefined;
  if (count !== undefined) updated.prompt_tokens_details = { ...(isJsonObject(details) && details), cached_tokens: count };
  return { ...event, usage: updated };
}
