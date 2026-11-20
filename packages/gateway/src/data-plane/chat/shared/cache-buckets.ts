import { readJsonNumber, asJsonObject, type JsonObject } from '../../../shared/json-helpers.ts';
import { foldsExclusiveCacheTokens } from '../../shared/telemetry/usage.ts';

/** Where a protocol keeps the numbers the cache-bucket fold reads. The names are the whole of
 *  what a protocol contributes: the decision, the two contradictions it raises and the
 *  arithmetic are one rule, and it is written once below. */
export interface CacheBucketNames {
  readonly input: string;
  readonly output: string;
  readonly details: string;
  /** Read in the order given, because an upstream projecting Anthropic's cache-write bucket
   *  onto an OpenAI-shaped usage block may spell it either way. */
  readonly cacheWrite: readonly string[];
}

/**
 * Restores OpenAI's inclusive input-token contract on a usage block that reports the cache
 * buckets alongside the input total instead of inside it.
 *
 * OpenAI states the subset relationship outright — "Cached tokens here are counted as a subset
 * of input tokens, meaning input tokens will include cached and uncached tokens"
 * (https://github.com/openai/openai-openapi/blob/d4fb706e6e05d4cc9f1b33ca59b6e4f3e8edd439/openapi.yaml#L51043-L51049)
 * — and every downstream consumer here subtracts on that basis. Anthropic takes the opposite
 * convention: `input_tokens` counts only what was neither read from nor written to the cache,
 * and the three buckets sum to the real input
 * (https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching).
 *
 * A gateway that fronts an Anthropic-shaped upstream and projects it into an OpenAI shape can
 * carry the exclusive convention through to a wire that declares the inclusive one. Portkey
 * does exactly that — it assigns Anthropic's `input_tokens` straight to `prompt_tokens` while
 * summing `total_tokens` from all four buckets
 * (https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/anthropic/chatComplete.ts#L612-L627).
 * Charm Hyper produces the same shape by subtracting the cached prefix out of the input total
 * it received: for one observed kimi-k3 turn it reported `prompt_tokens 479, cached_tokens
 * 13312, completion_tokens 373, total_tokens 14164`, where 479 + 13312 + 373 = 14164.
 *
 * `foldsExclusiveCacheTokens` owns the decision and the two contradictions that must not pass
 * silently; the `usage-exclusive-cached-tokens` flag is its declaration input. `total_tokens`
 * itself is left alone: under the exclusive convention it already counts the real input, so
 * the rewritten input plus output is what it was equal to all along. A block with nothing to
 * fold comes back by identity.
 */
export const withCacheBucketsFolded = (
  usage: JsonObject,
  names: CacheBucketNames,
  declaredExclusive: boolean,
  identity: string,
): JsonObject => {
  const inputTokens = readJsonNumber(usage[names.input]);
  const outputTokens = readJsonNumber(usage[names.output]);
  if (inputTokens == null || outputTokens == null) return usage;

  const details = asJsonObject(usage[names.details]);
  const cacheRead = readJsonNumber(details?.cached_tokens) ?? 0;
  const cacheWrite = names.cacheWrite.map(name => readJsonNumber(details?.[name])).find(value => value != null) ?? 0;
  if (cacheRead === 0 && cacheWrite === 0) return usage;

  const folds = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens,
    outputTokens,
    totalTokens: readJsonNumber(usage.total_tokens) ?? undefined,
    cacheRead,
    cacheWrite,
  }, identity);
  if (!folds) return usage;

  return { ...usage, [names.input]: inputTokens + cacheRead + cacheWrite };
};
