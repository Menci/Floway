// DeepSeek accepts reasoning_content in assistant tool-loop history and uses
// thinking.type to disable reasoning. The configured dialect adapter converts
// foreign scalar aliases and LiteLLM summaries before provider dispatch.
// https://api-docs.deepseek.com/guides/thinking_mode
// https://api-docs.deepseek.com/guides/kv_cache
// https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi

import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import { providerModelOf } from '@floway-dev/provider';

const synthesizeFromItems = (items: OpenAIChatCompletionsReasoningItem[] | null | undefined): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap(item => item.summary?.map(s => s.text) ?? []);
  return parts.length > 0 ? parts.join('') : undefined;
};

const rewriteOutboundMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  if (message.role !== 'assistant') return message;
  const { reasoning, reasoning_text, reasoning_opaque: _opaque, reasoning_items, ...rest } = message as OpenAIChatCompletionsAssistantMessageEx;
  const text = typeof rest.reasoning_content === 'string' ? rest.reasoning_content
    : typeof reasoning_text === 'string' ? reasoning_text
      : typeof reasoning === 'string' ? reasoning
        : synthesizeFromItems(reasoning_items as OpenAIChatCompletionsReasoningItem[] | null | undefined);
  if (text === undefined) return rest as OpenAIChatCompletionsMessage;
  return { ...rest, reasoning_content: text } as OpenAIChatCompletionsMessage;
};

const stripCanonicalReasoningSentinel = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => {
  if (payload.reasoning_effort !== 'none') return payload;
  const { reasoning_effort: _stripped, ...rest } = payload;
  return { ...rest, thinking: { type: 'disabled' as const } } as OpenAIChatCompletionsPayload;
};

const downgradeJsonSchemaResponseFormat = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => {
  const rf = payload.response_format;
  if (rf?.type !== 'json_schema') return payload;
  return { ...payload, response_format: { type: 'json_object' } };
};

const rewriteOutboundPayload = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => {
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
  const usage = asJsonObject(chunk.usage);
  if (!usage) return chunk;
  const hit = readJsonNumber(usage.prompt_cache_hit_tokens);
  const hasVendorField = VENDOR_CACHE_FIELDS.some(field => usage[field] !== undefined);
  if (!hasVendorField) return chunk;

  const next: JsonObject = { ...usage };
  for (const field of VENDOR_CACHE_FIELDS) delete next[field];
  if (hit != null) {
    next.prompt_tokens_details = {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: hit,
    };
  }
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

export const withVendorDeepSeekOpenAIChatCompletionsNormalize: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('vendor-deepseek')) return await run();

  ctx.payload = rewriteOutboundPayload(ctx.payload);

  const result = await run();
  if (result.type !== 'events') return result;

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const event = rewriteInboundUsage(rewriteInboundDeltas(frame.event));
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
