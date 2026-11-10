import type * as Beta from './sdk-beta.ts';
import type * as Native from './sdk-stable.ts';

export type AnthropicMessagesUsageIteration = Beta.BetaIterationsUsage[number];

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

export const createAnthropicMessagesUsage = (inputTokens: number, outputTokens: number): AnthropicMessagesUsage => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
});

export const usageDeltaKeys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens_details', 'server_tool_use', 'iterations', 'fallback_credit'] as const;

export const toAnthropicMessagesUsageDelta = (usage: AnthropicMessagesUsage | AnthropicMessagesUsageDelta): AnthropicMessagesUsageDelta => ({
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cache_creation_input_tokens: usage.cache_creation_input_tokens,
  cache_read_input_tokens: usage.cache_read_input_tokens,
  output_tokens_details: usage.output_tokens_details,
  server_tool_use: usage.server_tool_use,
  ...(usage.iterations === undefined ? {} : { iterations: usage.iterations }),
  ...(usage.fallback_credit === undefined ? {} : { fallback_credit: usage.fallback_credit }),
});

export const toAnthropicMessagesUsageDeltaEx = (usage: AnthropicMessagesUsage): AnthropicMessagesUsageDeltaEx => ({
  ...toAnthropicMessagesUsageDelta(usage),
  ...(usage.cache_creation === null ? {} : { cache_creation: usage.cache_creation }),
  ...(usage.service_tier === null ? {} : { service_tier: usage.service_tier }),
  ...(usage.speed == null ? {} : { speed: usage.speed }),
  ...(usage.inference_geo === null ? {} : { inference_geo: usage.inference_geo }),
});

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
  return {
    ...current,
    ...(delta.cache_creation === undefined ? {} : { cache_creation: delta.cache_creation ?? undefined }),
    ...(present(delta.service_tier) ? { service_tier: delta.service_tier } : {}),
    ...(present(delta.speed) ? { speed: delta.speed } : {}),
    output_tokens: delta.output_tokens,
    ...(present(delta.input_tokens) ? { input_tokens: delta.input_tokens } : {}),
    ...(present(delta.cache_read_input_tokens) ? { cache_read_input_tokens: delta.cache_read_input_tokens } : {}),
    ...(present(delta.cache_creation_input_tokens) ? { cache_creation_input_tokens: delta.cache_creation_input_tokens } : {}),
    ...(present(delta.output_tokens_details) ? { output_tokens_details: { ...delta.output_tokens_details } } : {}),
    ...(present(delta.iterations) ? { iterations: cloneAnthropicMessagesUsageIterations(delta.iterations) } : {}),
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
