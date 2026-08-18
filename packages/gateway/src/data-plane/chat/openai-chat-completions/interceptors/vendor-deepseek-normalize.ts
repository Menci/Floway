// DeepSeek wire-dialect normalizer for OpenAI Chat Completions. Always-attached;
// flag-gated by `vendor-deepseek`. Runs last among the gateway's interceptors
// so it has the final say on the outbound wire body and the first say on the
// inbound stream — the gateway's generic interceptors above it deal only in
// OpenAI-canonical form.
//
// Outbound (request → upstream):
//
// - `reasoning_effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel (produced when a Anthropic Messages source had `thinking: { type:
//   'disabled' }`, when a Chat source sent it literally, etc.). DeepSeek
//   doesn't accept 'none' in its `reasoning_effort` enum and instead uses
//   a top-level `thinking: { type: 'disabled' }` field. We strip the
//   sentinel and emit the DeepSeek form.
// - Assistant messages: rewrite `reasoning_text` → `reasoning_content` (and
//   synthesise `reasoning_content` from `reasoning_items.summary` when the
//   newer OpenAI shape is the only thing present). DeepSeek documents only
//   the scalar `reasoning_content` field and reports 400s when it is
//   omitted from the assistant-message replay of a multi-turn tool-call loop.
// - `response_format: { type: 'json_schema', … }` is downgraded to
//   `response_format: { type: 'json_object' }`. DeepSeek's structured-output
//   API supports only `json_object`; the schema body is dropped on the floor
//   rather than rejected by the upstream.
//
// Inbound (stream → client):
//
// - Each delta: rewrite `reasoning_content` → `reasoning_text` so downstream
//   gateway code sees the OpenAI shape.
// - Each usage chunk: remap `prompt_cache_hit_tokens` /
//   `prompt_cache_miss_tokens` into OpenAI's
//   `prompt_tokens_details.cached_tokens`. The remap is computed from
//   `prompt_cache_hit_tokens` alone (DeepSeek's "hit" count is the cached
//   prefix length); the "miss" field is dropped.
//
// References:
// - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// - https://api-docs.deepseek.com/guides/kv_cache
// - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi

import type { OpenAIChatCompletionsInterceptor } from './types.ts';
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import { providerModelOf } from '@floway-dev/provider';

const synthesizeFromItems = (items: OpenAIChatCompletionsReasoningItem[] | null | undefined): string | undefined => {
  if (!items?.length) return undefined;
  const parts = items.flatMap(item => item.summary?.map(s => s.text) ?? []);
  return parts.length > 0 ? parts.join('') : undefined;
};

const rewriteOutboundMessage = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  // `reasoning_opaque` is the OpenAI-canonical signature for cross-turn
  // reasoning replay; DeepSeek doesn't accept it, so it's dropped on the
  // floor when we project assistant messages onto `reasoning_content`.
  const { reasoning_text, reasoning_opaque: _opaque, reasoning_items, ...rest } = message;
  const text = typeof reasoning_text === 'string' ? reasoning_text : synthesizeFromItems(reasoning_items);
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
    const delta = choice.delta as OpenAIChatCompletionsStreamEvent['choices'][number]['delta'] & { reasoning_content?: unknown };
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
