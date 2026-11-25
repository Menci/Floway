import { factSpace, move, transform } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsReasoningItemEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'provider.model' | 'request.openaiChatCompletions' | 'response.openaiChatCompletions'>>();

// DeepSeek takes its own thinking control, reasoning replay, JSON format, and cache usage fields.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/guides/kv_cache
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
export const normalizeDeepSeek = defineStage({
  name: 'azure.openaiChatCompletions.normalizeDeepSeek',
  through: {
    request: { needs: ['provider.model', 'request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: ['response.openaiChatCompletions'], provides: ['response.openaiChatCompletions'], consumes: [] },
  },
  execute: transform(scope => {
    let enabled: boolean;
    return {
      request: facts => {
        enabled = facts['provider.model'].enabledFlags.includes('vendor-deepseek');
        if (!enabled) return facts;
        return { ...facts, 'request.openaiChatCompletions': move(rewriteOutboundPayload(facts['request.openaiChatCompletions'])) };
      },
      response: back => {
        const outcome = back['response.openaiChatCompletions'];
        if (!enabled || outcome.kind !== 'stream') return back;
        const stream = scope.wrapStream(outcome.stream, async function* (source) {
          for await (const item of source) {
            if (!item.ok) {
              yield item;
              continue;
            }
            const value = rewriteInboundUsage(rewriteInboundDeltas(item.value));
            yield value === item.value ? item : { ok: true, value };
          }
        });
        return { ...back, 'response.openaiChatCompletions': move({ kind: 'stream', stream }) };
      },
    };
  }),
});

const synthesizeFromItems = (items: OpenAIChatCompletionsReasoningItemEx[] | null | undefined): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap(item => item.summary?.map(part => part.text) ?? []);
  return parts.length > 0 ? parts.join('') : undefined;
};

const rewriteOutboundMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const { reasoning_text, reasoning_opaque: _opaque, reasoning_items, ...rest } = message as OpenAIChatCompletionsAssistantMessageEx;
  const text = typeof reasoning_text === 'string' ? reasoning_text : synthesizeFromItems(reasoning_items as OpenAIChatCompletionsReasoningItemEx[] | null | undefined);
  return text === undefined ? rest : { ...rest, reasoning_content: text } as OpenAIChatCompletionsMessage;
};

const stripCanonicalReasoningSentinel = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _stripped, ...rest } = payload;
  return { ...rest, thinking: { type: 'disabled' } } as OpenAIChatCompletionsPayloadEx;
};

const rewriteOutboundPayload = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const withDisable = stripCanonicalReasoningSentinel(payload);
  const withResponseFormat = withDisable.response_format?.type === 'json_schema'
    ? { ...withDisable, response_format: { type: 'json_object' as const } }
    : withDisable;
  return { ...withResponseFormat, messages: withResponseFormat.messages.map(rewriteOutboundMessage) };
};

const rewriteInboundDeltas = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  let changed = false;
  const choices = chunk.choices.map(choice => {
    const delta = choice.delta as OpenAIChatCompletionsAssistantDeltaEx;
    if (typeof delta.reasoning_content !== 'string') return choice;
    const { reasoning_content, ...rest } = delta;
    changed = true;
    return {
      ...choice,
      delta: { ...rest, ...(delta.reasoning_text === undefined ? { reasoning_text: reasoning_content } : {}) },
    };
  });
  return changed ? { ...chunk, choices } : chunk;
};

const rewriteInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const wireUsage: unknown = chunk.usage;
  if (!isJsonObject(wireUsage)) return chunk;
  const { prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, ...usage } = wireUsage;
  if (hit === undefined && miss === undefined) return chunk;
  if (typeof hit === 'number') {
    usage.prompt_tokens_details = {
      ...(isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}),
      cached_tokens: hit,
    };
  }
  return { ...chunk, usage: usage as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
};
