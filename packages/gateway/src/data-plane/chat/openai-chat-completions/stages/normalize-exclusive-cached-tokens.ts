// Restore OpenAI's inclusive input-token contract on upstreams that report the
// cache buckets alongside `prompt_tokens` instead of inside it.
//
// OpenAI states the subset relationship outright: cached tokens are a subset of
// input tokens, and input tokens include both cached and uncached tokens.
// https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049
// Anthropic takes the opposite convention: `input_tokens` counts only what was
// neither read from nor written to the cache, and the three buckets sum to the
// real input. https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
//
// Portkey projects Anthropic's exclusive counts onto OpenAI's inclusive field
// without converting them, while Charm Hyper subtracts the cached prefix from
// `prompt_tokens`. `foldsExclusiveCacheTokens` owns the detection and refuses
// contradictions; the `usage-exclusive-cached-tokens` flag settles totals that
// withhold the decisive `total_tokens` value. The rewritten
// `prompt_tokens + completion_tokens` agrees with the untouched `total_tokens`.
// https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const rewriteInboundUsage = (
  chunk: OpenAIChatCompletionsStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): OpenAIChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (usage === null) return chunk;
  const inputTokens = readJsonNumber(usage.prompt_tokens);
  const outputTokens = readJsonNumber(usage.completion_tokens);
  if (inputTokens === null || outputTokens === null) return chunk;

  const details = asJsonObject(usage.prompt_tokens_details);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(details?.cache_creation_input_tokens)
    ?? readJsonNumber(details?.cache_write_tokens)
    ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return chunk;

  const fold = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity);
  if (!fold) return chunk;

  const next: JsonObject = { ...usage, prompt_tokens: inputTokens + cacheRead + cacheWrite };
  return { ...chunk, usage: next as unknown as OpenAIChatCompletionsStreamEvent['usage'] };
};

// This normalization applies only to a native OpenAI Chat Completions wire.
// A translated request receives canonical usage from its target protocol.
export const normalizeExclusiveCachedTokens = defineStage<
  Facts,
  Record<never, never>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'normalizeExclusiveCachedTokens',
  execute: async (facts, next, env) => {
    const outcome = await next();
    if (outcome.type !== 'events' || facts['route.targetApi'] !== 'openaiChatCompletions') return outcome;

    const candidate = facts['route.candidate'];
    const declaredExclusive = hasEnabledFlag(candidate.providerModel, 'usage-exclusive-cached-tokens');
    const identity = `${candidate.upstreamId}/${candidate.modelId}`;
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'openai-chat-completions.normalize-exclusive-cached-tokens',
        async *transform(source) {
          for await (const frame of source) {
            if (frame.type !== 'event') {
              yield frame;
              continue;
            }
            const event = rewriteInboundUsage(frame.event, declaredExclusive, identity);
            if (event === frame.event) {
              yield frame;
              continue;
            }
            if (outcome.usageId !== undefined) {
              const usage = billableUsageFromOpenAIChatCompletionsEvent(event);
              if (usage !== null) env.usageLedger.updateBillableUsage(outcome.usageId, usage);
            }
            yield eventFrame(event);
          }
        },
      }),
    };
  },
});
