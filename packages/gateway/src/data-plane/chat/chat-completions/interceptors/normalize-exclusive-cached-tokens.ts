// Restores OpenAI's inclusive input-token contract on upstreams that report
// the cache buckets alongside `prompt_tokens` instead of inside it.
//
// OpenAI states the subset relationship outright — "Cached tokens here are
// counted as a subset of input tokens, meaning input tokens will include
// cached and uncached tokens"
// (https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049)
// — and every downstream consumer here subtracts on that basis. Anthropic
// takes the opposite convention: `input_tokens` counts only what was neither
// read from nor written to the cache, and the three buckets sum to the real
// input (https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching).
//
// A gateway that fronts an Anthropic-shaped upstream and projects it into
// Chat Completions can carry the exclusive convention through to a wire that
// declares the inclusive one. Portkey does exactly that — it assigns
// Anthropic's `input_tokens` straight to `prompt_tokens` while summing
// `total_tokens` from all four buckets
// (https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627).
// Charm Hyper produces the same shape by subtracting the cached prefix out of
// the `prompt_tokens` it received: for one observed kimi-k3 turn it reported
// `prompt_tokens 479, cached_tokens 13312, completion_tokens 373,
// total_tokens 14164`, where 479 + 13312 + 373 = 14164.
//
// `foldsExclusiveCacheTokens` owns the decision and the two contradictions
// that must not pass silently; the `usage-exclusive-cached-tokens` flag is its
// declaration input. `total_tokens` itself is left alone: under the exclusive
// convention it already counts the real input, so the rewritten
// `prompt_tokens + completion_tokens` is what it was equal to all along.

import type { ChatCompletionsInterceptor } from './types.ts';
import { asJsonObject, type JsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { foldsExclusiveCacheTokens } from '../../../shared/telemetry/usage.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';
import { providerModelOf } from '@floway-dev/provider';

const rewriteInboundUsage = (
  chunk: ChatCompletionsStreamEvent,
  declaredExclusive: boolean,
  identity: string,
): ChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage);
  if (!usage) return chunk;
  const inputTokens = readJsonNumber(usage.prompt_tokens);
  const outputTokens = readJsonNumber(usage.completion_tokens);
  if (inputTokens == null || outputTokens == null) return chunk;

  const details = asJsonObject(usage.prompt_tokens_details);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = readJsonNumber(details?.cache_creation_input_tokens) ?? readJsonNumber(details?.cache_write_tokens) ?? 0;
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
  return { ...chunk, usage: next as unknown as ChatCompletionsStreamEvent['usage'] };
};

export const withExclusiveCachedTokensNormalized: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  // Everything this entry says is about one upstream's Chat Completions wire:
  // the flag it reads describes how that upstream writes its usage there, and
  // the remedy its errors name is a setting for that upstream. A translated
  // request re-enters its target's chain, where these events are a projection
  // of some other wire — the flag answers a question about counts it does not
  // describe, and telling an operator to set it would be advice that cannot
  // help. Nothing is lost by standing down: a translator emits the canonical
  // form, which is the one case the fold has nothing to do with.
  if (ctx.targetApi !== 'chat-completions') return await run();

  const model = providerModelOf(ctx.candidate);
  const declaredExclusive = model.enabledFlags.has('usage-exclusive-cached-tokens');
  const identity = `${ctx.candidate.provider.upstreamId}/${model.id}`;

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
        const event = rewriteInboundUsage(frame.event, declaredExclusive, identity);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
