import type * as Beta from './sdk-beta.ts';
import type * as Native from './sdk-stable.ts';

export type AnthropicMessagesUsageIteration = Beta.BetaIterationsUsage[number];

// The beta usage union includes model attempts, advisor attempts, and
// compaction entries, and remains additively extensible. Floway only needs an
// isolated opaque snapshot, not a closed projection of those variants.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/messages/messages.ts#L1724-L1829
export const cloneAnthropicMessagesUsageIterations = (iterations: AnthropicMessagesUsageIteration[] | null): AnthropicMessagesUsageIteration[] | null =>
  iterations === null ? null : structuredClone(iterations);

export interface AnthropicMessagesCacheCreationTtlTokens {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

// Both SDK variants share required nullable fields; beta-only fields remain
// optional in the unified wire view. Open-string values pass through unchanged.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3905-L3955
export type AnthropicMessagesUsage = Omit<Native.Usage, 'service_tier'> & Partial<Pick<Beta.BetaUsage, 'iterations' | 'fallback_credit'>> & {
  service_tier: Native.Usage['service_tier'] | (string & {});
  speed?: Beta.BetaUsage['speed'] | (string & {});
};

export type AnthropicMessagesUsageDelta = Omit<Pick<AnthropicMessagesUsage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens_details' | 'server_tool_use' | 'iterations' | 'fallback_credit'>, 'input_tokens'> & {
  input_tokens: number | null;
};

export interface AnthropicMessagesUsageDeltaEx extends AnthropicMessagesUsageDelta {
  // new-api sends the complete usage snapshot in its final delta, including TTL buckets.
  // https://github.com/QuantumNous/new-api/blob/6370b29424168039e94d40d610191e7d2e65dbf4/relaykit/relayconvert/internal/oai_chat/to_claude_messages_resp.go#L215-L235
  cache_creation?: AnthropicMessagesCacheCreationTtlTokens | null;
  // Floway uses the same full-usage convention for late fixed metadata.
  service_tier?: AnthropicMessagesUsage['service_tier'];
  speed?: AnthropicMessagesUsage['speed'];
  inference_geo?: AnthropicMessagesUsage['inference_geo'];
}

// The whole-message totals, carried by the non-streaming response body and by
// the `message_start` snapshot that reuses it — the two places upstream
// declares `input_tokens` non-null. Upstream's own delta carrier declares a
// narrower field set than the type above, which stays widened because real
// upstreams do repeat the tier and per-TTL fields on `message_delta`.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/18ea26d324911c3236f2ce762dd0c87f04d038d3/src/resources/messages/messages.ts#L2362-L2412
export interface AnthropicMessagesUsage extends Omit<AnthropicMessagesUsageDelta, 'input_tokens'> {
  input_tokens: number;
}

export interface AnthropicMessagesCacheCreationUsage {
  cache_creation_input_tokens?: number;
  cache_creation?: AnthropicMessagesCacheCreationTtlTokens;
}

// Usage as Floway accounts for it: the upstream counters with every `null`
// already collapsed to absence, so consumers test presence rather than repeat
// the wire's two spellings of "no value". `iterations` keeps its explicit
// `null`, which upstream uses to state that a turn ran no iterations at all.
export interface AnthropicMessagesUsageSnapshot extends AnthropicMessagesCacheCreationUsage {
  input_tokens?: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens: number };
  service_tier?: string;
  speed?: string;
  iterations?: AnthropicMessagesUsageIteration[] | null;
}

const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

export const anthropicMessagesUsageSnapshot = (usage?: Partial<Omit<AnthropicMessagesUsage, 'input_tokens' | 'cache_creation' | 'output_tokens'>> & { output_tokens: number; input_tokens?: number | null; cache_creation?: AnthropicMessagesCacheCreationTtlTokens | null }): AnthropicMessagesUsageSnapshot => usage === undefined
  ? { output_tokens: 0 }
  : {
      output_tokens: usage.output_tokens,
      ...(present(usage.input_tokens) ? { input_tokens: usage.input_tokens } : {}),
      ...(present(usage.cache_read_input_tokens) ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
      ...(present(usage.cache_creation_input_tokens) ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
      ...(present(usage.cache_creation) ? { cache_creation: { ...usage.cache_creation } } : {}),
      ...(present(usage.output_tokens_details) ? { output_tokens_details: { ...usage.output_tokens_details } } : {}),
      ...(present(usage.service_tier) ? { service_tier: usage.service_tier } : {}),
      ...(present(usage.speed) ? { speed: usage.speed } : {}),
      ...(usage.iterations === undefined ? {} : { iterations: cloneAnthropicMessagesUsageIterations(usage.iterations) }),
    };

export const mergeAnthropicMessagesUsageSnapshot = (
  current: AnthropicMessagesUsageSnapshot,
  delta: Partial<AnthropicMessagesUsageDeltaEx> & { output_tokens: number },
): AnthropicMessagesUsageSnapshot => {
  const update = anthropicMessagesUsageSnapshot(delta);
  return {
    ...current,
    ...update,
    // The served tier is one fact spelled by two fields, so an update that
    // states either one restates both and neither may survive from an earlier
    // event on its own.
    ...(update.speed === undefined && update.service_tier === undefined
      ? {}
      : { speed: update.speed, service_tier: update.service_tier }),
  };
};

export const splitAnthropicMessagesCacheCreationTokens = (
  usage: AnthropicMessagesCacheCreationUsage,
): { cacheWrite: number; cacheWrite1h: number } => {
  const flat = usage.cache_creation_input_tokens;
  const cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  for (const [name, value] of [
    ['cache_creation_input_tokens', flat],
    ['ephemeral_5m_input_tokens', cacheWrite5m],
    ['ephemeral_1h_input_tokens', cacheWrite1h],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative safe integer: ${value}`);
    }
  }

  if (flat === undefined) {
    return { cacheWrite: cacheWrite5m ?? 0, cacheWrite1h: cacheWrite1h ?? 0 };
  }
  if (cacheWrite5m !== undefined && cacheWrite1h !== undefined) {
    if (cacheWrite5m + cacheWrite1h !== flat) {
      throw new RangeError('cache creation TTL counts must sum to cache_creation_input_tokens');
    }
    return { cacheWrite: cacheWrite5m, cacheWrite1h };
  }
  if (cacheWrite5m !== undefined) {
    if (cacheWrite5m > flat) throw new RangeError('cache creation TTL counts exceed cache_creation_input_tokens');
    return { cacheWrite: cacheWrite5m, cacheWrite1h: flat - cacheWrite5m };
  }
  if (cacheWrite1h !== undefined) {
    if (cacheWrite1h > flat) throw new RangeError('cache creation TTL counts exceed cache_creation_input_tokens');
    return { cacheWrite: flat - cacheWrite1h, cacheWrite1h };
  }
  return { cacheWrite: flat, cacheWrite1h: 0 };
};
