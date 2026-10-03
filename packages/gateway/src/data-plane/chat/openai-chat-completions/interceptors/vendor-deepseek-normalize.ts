// DeepSeek wire-dialect normalizer for OpenAI Chat Completions. Always-attached;
// flag-gated by `vendor-deepseek`. Runs last among the gateway's interceptors
// so it has the final say on the outbound wire body and the first say on the
// inbound stream — the gateway's generic interceptors above it deal only in
// OpenAI-canonical form.
//
// Outbound (request → upstream):
//
// - `reasoning_effort: 'none'` is the gateway's canonical "no reasoning"
//   sentinel (produced when an Anthropic Messages source had `thinking: { type:
//   'disabled' }`, when an OpenAI Chat Completions source sent it literally, etc.). DeepSeek
//   doesn't accept 'none' in its `reasoning_effort` enum and instead uses
//   a top-level `thinking: { type: 'disabled' }` field. We strip the
//   sentinel and emit the DeepSeek form.
// - `response_format: { type: 'json_schema', … }` is downgraded to
//   `response_format: { type: 'json_object' }`. DeepSeek's structured-output
//   API supports only `json_object`; the schema body is dropped on the floor
//   rather than rejected by the upstream.
//
// Inbound (stream → client):
//
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
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { providerModelOf } from '@floway-dev/provider';

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

  ctx.payload = downgradeJsonSchemaResponseFormat(stripCanonicalReasoningSentinel(ctx.payload));

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
        const event = rewriteInboundUsage(frame.event);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
