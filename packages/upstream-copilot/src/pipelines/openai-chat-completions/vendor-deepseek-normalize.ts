import { defineCopilotStage } from '../facts.ts';
import { readUsageNumber } from '../shared/read-usage-number.ts';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
// DeepSeek normalization is selected by the upstream model's flag.
// References:
// - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// - https://api-docs.deepseek.com/guides/kv_cache
// - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsReasoningItemEx, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

const synthesizeFromItems = (items: OpenAIChatCompletionsReasoningItemEx[] | null | undefined): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap(item => item.summary?.map(s => s.text) ?? []);
  return parts.length > 0 ? parts.join('') : undefined;
};

const rewriteOutboundMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  // `reasoning_opaque` is the OpenAI-canonical signature for cross-turn
  // reasoning replay; DeepSeek doesn't accept it, so it's dropped on the
  // floor when we project assistant messages onto `reasoning_content`.
  if (message.role !== 'assistant') return message;
  const { reasoning_text, reasoning_opaque: _opaque, reasoning_items, ...rest } = message as OpenAIChatCompletionsAssistantMessageEx;
  const text = typeof reasoning_text === 'string' ? reasoning_text : synthesizeFromItems(reasoning_items as OpenAIChatCompletionsReasoningItemEx[] | null | undefined);
  if (text === undefined) return rest as OpenAIChatCompletionsMessage;
  return { ...rest, reasoning_content: text } as OpenAIChatCompletionsMessage;
};

const stripCanonicalReasoningSentinel = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _stripped, ...rest } = payload;
  return { ...rest, thinking: { type: 'disabled' as const } } as OpenAIChatCompletionsPayloadEx;
};

const downgradeJsonSchemaResponseFormat = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const rf = payload.response_format;
  if (rf?.type !== 'json_schema') return payload;
  return { ...payload, response_format: { type: 'json_object' } };
};

const rewriteOutboundPayload = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  const withDisable = stripCanonicalReasoningSentinel(payload);
  const withResponseFormat = downgradeJsonSchemaResponseFormat(withDisable);
  return {
    ...withResponseFormat,
    messages: withResponseFormat.messages.map(rewriteOutboundMessage),
  };
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
      delta: {
        ...rest,
        ...(delta.reasoning_text === undefined ? { reasoning_text: reasoning_content } : {}),
      },
    };
  });
  return changed ? { ...chunk, choices } : chunk;
};

const VENDOR_CACHE_FIELDS = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'] as const;

const rewriteInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage: unknown = chunk.usage;
  if (!isJsonObject(usage)) return chunk;
  const hit = readUsageNumber(usage.prompt_cache_hit_tokens);
  const hasVendorField = VENDOR_CACHE_FIELDS.some(field => usage[field] !== undefined);
  if (!hasVendorField) return chunk;

  const { prompt_cache_hit_tokens: _hit, prompt_cache_miss_tokens: _miss, ...rest } = usage;
  const next: JsonObject = { ...rest };
  if (hit != null) {
    next.prompt_tokens_details = {
      ...(isJsonObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}),
      cached_tokens: hit,
    };
  }
  return { ...chunk, usage: next as unknown as NonNullable<OpenAIChatCompletionsStreamEvent['usage']> };
};

export const normalizeDeepSeek = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.normalizeDeepSeek',
  through: {
    request: { needs: ['model', 'openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: ['openaiChatCompletions'], provides: ['openaiChatCompletions'], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts['model'].enabledFlags.includes('vendor-deepseek')) return await scope.next(facts);
    const payload = rewriteOutboundPayload(facts['openaiChatCompletions']);
    const back = await scope.next({ ...facts, 'openaiChatCompletions': payload });
    const outcome = back['openaiChatCompletions'];
    if (outcome.kind !== 'stream') return back;

    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        yield item.ok && Array.isArray(item.value.choices)
          ? { ok: true, value: rewriteInboundUsage(rewriteInboundDeltas(item.value)) }
          : item;
      }
    });
    return { ...back, 'openaiChatCompletions': { kind: 'stream', stream } };
  },
});
