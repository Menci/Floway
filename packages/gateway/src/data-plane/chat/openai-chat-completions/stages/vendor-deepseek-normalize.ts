// DeepSeek's OpenAI-compatible wire uses its own dialect. Outbound, it maps the
// gateway's `reasoning_effort: 'none'` sentinel to a disabled-thinking object,
// rewrites assistant reasoning to `reasoning_content`, and downgrades JSON
// schema output to the object mode DeepSeek supports. Inbound, it restores
// canonical reasoning deltas and cache-hit usage fields.
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// https://api-docs.deepseek.com/guides/kv_cache
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIChatCompletionsAssistantDeltaEx,
  OpenAIChatCompletionsAssistantMessageEx,
  OpenAIChatCompletionsMessage,
  OpenAIChatCompletionsPayloadEx,
  OpenAIChatCompletionsReasoningItemEx,
  OpenAIChatCompletionsStreamEvent,
} from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const synthesizeFromItems = (items: OpenAIChatCompletionsReasoningItemEx[] | null | undefined): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap(item => item.summary?.map(summary => summary.text) ?? []);
  return parts.length === 0 ? undefined : parts.join('');
};

const rewriteOutboundMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const {
    reasoning_text,
    reasoning_opaque: _opaque,
    reasoning_items,
    ...rest
  } = message as OpenAIChatCompletionsAssistantMessageEx;
  const text = typeof reasoning_text === 'string'
    ? reasoning_text
    : synthesizeFromItems(reasoning_items as OpenAIChatCompletionsReasoningItemEx[] | null | undefined);
  return text === undefined ? rest as OpenAIChatCompletionsMessage : { ...rest, reasoning_content: text } as OpenAIChatCompletionsMessage;
};

const rewriteOutboundPayload = (payload: OpenAIChatCompletionsPayloadEx): OpenAIChatCompletionsPayloadEx => {
  let next = payload;
  if (next.reasoning_effort === 'none') {
    const { reasoning_effort: _stripped, ...rest } = next;
    next = { ...rest, thinking: { type: 'disabled' } } as OpenAIChatCompletionsPayloadEx;
  }
  if (next.response_format?.type === 'json_schema') {
    next = { ...next, response_format: { type: 'json_object' } };
  }
  return { ...next, messages: next.messages.map(rewriteOutboundMessage) };
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
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const hit = readJsonNumber(usage.prompt_cache_hit_tokens);
  if (!VENDOR_CACHE_FIELDS.some(field => usage[field] !== undefined)) return chunk;

  const next: JsonObject = { ...usage };
  for (const field of VENDOR_CACHE_FIELDS) delete next[field];
  if (hit !== null) {
    next.prompt_tokens_details = {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: hit,
    };
  }
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

// This is always attached and flag-gated. It is the innermost vendor stage so it
// reads upstream dialect frames before generic usage normalization.
export const vendorDeepSeekNormalize = defineStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'vendorDeepSeekNormalize',
  provides: ['request.payload'],
  execute: async (facts, next, env) => {
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'vendor-deepseek')) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const outcome = await next({ 'request.payload': rewriteOutboundPayload(facts['request.payload']) });
    if (outcome.type !== 'events') return outcome;
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'openai-chat-completions.vendor-deepseek',
        async *transform(source) {
          for await (const frame of source) {
            if (frame.type !== 'event') {
              yield frame;
              continue;
            }
            const withDeltas = rewriteInboundDeltas(frame.event);
            const event = rewriteInboundUsage(withDeltas);
            if (event.usage !== withDeltas.usage && outcome.usageId !== undefined) {
              const usage = billableUsageFromOpenAIChatCompletionsEvent(event);
              if (usage !== null) env.usageLedger.updateBillableUsage(outcome.usageId, usage);
            }
            yield event === frame.event ? frame : eventFrame(event);
          }
        },
      }),
    };
  },
});
