import { asJsonObject, readJsonNumber, type JsonObject } from '../../../shared/json-helpers.ts';
import type { Chat } from '../facts.ts';
import { answerWithFrames, rewritingEvents } from '../shared/frames.ts';
import { withoutKeys, mapKeepingIdentity } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsReasoningItem } from '@floway-dev/protocols/openai-chat-completions';

// ── OpenAI Chat Completions vendor dialects ───────────────────────────────────────────────
//
// Each of the three below is last among this wire's rewrites, which is what gives it the final
// say on the outbound body and the first say on the inbound stream: everything above deals
// only in OpenAI-canonical form. The vendor flags are mutually exclusive in practice, but the
// stages are independent and run in the order they are composed if more than one is somehow on.

/**
 * DeepSeek's wire dialect.
 *
 * Outbound: `reasoning_effort: 'none'` is the gateway's canonical "no reasoning" sentinel and
 * is not in DeepSeek's own enum, which uses a top-level `thinking: { type: 'disabled' }`
 * instead. Assistant messages carry their reasoning on the scalar `reasoning_content` DeepSeek
 * documents — it is the only field it reads, and it reports 400s when the assistant-message
 * replay of a multi-turn tool-call loop omits it. And `response_format: { type: 'json_schema' }`
 * is downgraded to `json_object`, which is the only structured output DeepSeek supports; the
 * schema body is dropped rather than rejected by the upstream.
 *
 * Inbound: `reasoning_content` deltas become `reasoning_text`, and the `prompt_cache_hit_tokens`
 * / `prompt_cache_miss_tokens` pair becomes OpenAI's `prompt_tokens_details.cached_tokens` —
 * computed from the hit count alone, which is the cached prefix length.
 *
 * References:
 * - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - https://api-docs.deepseek.com/guides/kv_cache
 * - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
 */
export const vendorDeepSeekNormalizeForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'vendorDeepSeekNormalize',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: {
      needs: ['response.chat.openaiChatCompletions'],
      consumes: [],
      provides: ['response.chat.openaiChatCompletions'],
    },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => {
    // Whether this vendor's dialect applies at all is read on the way down and acted on in
    // both directions, which is the order `transform` runs the two halves in.
    let enabled = false;
    return {
      request: facts => {
        enabled = facts['route.attempt'].flags.includes('vendor-deepseek');
        if (!enabled) return facts;
        const payload = facts['request.chat.openaiChatCompletions'];
        const normalized = deepSeekOutbound(payload);
        return normalized === payload ? facts : { ...facts, 'request.chat.openaiChatCompletions': move(normalized) };
      },
      response: facts => {
        if (!enabled) return facts;
        const answer = answerWithFrames<OpenAIChatCompletionsStreamEvent>(
          facts['response.chat.openaiChatCompletions'],
          frames => rewritingEvents(frames, chunk => deepSeekInboundUsage(deepSeekInboundDeltas(chunk))),
        );
        return answer === null ? facts : { ...facts, 'response.chat.openaiChatCompletions': move(answer) };
      },
    };
  }),
});

const deepSeekOutbound = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsPayload => {
  const withThinking = payload.reasoning_effort === 'none'
    ? { ...withoutKeys(payload, ['reasoning_effort']), thinking: { type: 'disabled' } } satisfies OpenAIChatCompletionsPayloadWithDeepSeekThinking
    : payload;
  const withResponseFormat = withThinking.response_format?.type === 'json_schema'
    ? { ...withThinking, response_format: { type: 'json_object' } }
    : withThinking;
  const messages = mapKeepingIdentity(withResponseFormat.messages, deepSeekAssistantReasoning);
  return messages === withResponseFormat.messages ? withResponseFormat : { ...withResponseFormat, messages };
};

/** The reasoning DeepSeek reads, and only that: `reasoning_opaque` is the OpenAI-canonical
 *  signature for cross-turn replay and DeepSeek does not accept it, so it goes with the two
 *  fields that are projected onto `reasoning_content`. */
const deepSeekAssistantReasoning = (message: OpenAIChatCompletionsMessage): OpenAIChatCompletionsMessage => {
  const stripped = withoutKeys(message, ['reasoning_text', 'reasoning_opaque', 'reasoning_items']);
  if (stripped === message) return message;
  const text = typeof message.reasoning_text === 'string'
    ? message.reasoning_text
    : deepSeekReasoningFromItems(message.reasoning_items);
  if (text === undefined) return stripped;
  const projected: OpenAIChatCompletionsMessageWithDeepSeekReasoning = { ...stripped, reasoning_content: text };
  return projected;
};

/** The newer OpenAI shape carries reasoning as summary items; DeepSeek documents only the
 *  scalar, so what summaries there are become it. */
const deepSeekReasoningFromItems = (items: OpenAIChatCompletionsReasoningItem[] | null | undefined): string | undefined => {
  const parts = items?.flatMap(item => item.summary?.map(summary => summary.text) ?? []) ?? [];
  return parts.length > 0 ? parts.join('') : undefined;
};

const deepSeekInboundDeltas = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const choices = mapKeepingIdentity(chunk.choices, choice => {
    const delta = choice.delta as OpenAIChatCompletionsDeltaWithDeepSeekReasoning;
    if (typeof delta.reasoning_content !== 'string') return choice;
    const stripped = withoutKeys(delta, ['reasoning_content']);
    return {
      ...choice,
      delta: delta.reasoning_text === undefined ? { ...stripped, reasoning_text: delta.reasoning_content } : stripped,
    };
  });
  return choices === chunk.choices ? chunk : { ...chunk, choices };
};

/** DeepSeek's "hit" count is the cached prefix length, which is what OpenAI's
 *  `cached_tokens` means; the "miss" count is what is left of the input and is dropped.
 *  `prompt_tokens` is documented as exactly hit + miss, and the cache matches only a prefix.
 *  https://api-docs.deepseek.com/api/create-chat-completion
 *  https://api-docs.deepseek.com/guides/kv_cache */
const DEEPSEEK_CACHE_FIELDS = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'] as const;

const deepSeekInboundUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const stripped = withoutKeys(usage, DEEPSEEK_CACHE_FIELDS);
  if (stripped === usage) return chunk;
  const hit = readJsonNumber(usage.prompt_cache_hit_tokens);
  const next: JsonObject = hit == null
    ? stripped
    : { ...stripped, prompt_tokens_details: { ...(asJsonObject(usage.prompt_tokens_details) ?? {}), cached_tokens: hit } };
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

/** None of the three fields is an OpenAI Chat Completions field, so each is declared beside the vendor
 *  that reads it rather than widening the protocol's own types. */
type OpenAIChatCompletionsPayloadWithDeepSeekThinking = Omit<OpenAIChatCompletionsPayload, 'reasoning_effort'> & { thinking: { type: string } };

type OpenAIChatCompletionsMessageWithDeepSeekReasoning =
  Omit<OpenAIChatCompletionsMessage, 'reasoning_text' | 'reasoning_opaque' | 'reasoning_items'> & { reasoning_content: string };

type OpenAIChatCompletionsDeltaWithDeepSeekReasoning =
  OpenAIChatCompletionsStreamEvent['choices'][number]['delta'] & { reasoning_content?: unknown };
