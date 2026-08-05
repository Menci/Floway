export interface MessagesUsageServerToolUse {
  web_search_requests?: number;
}

export interface MessagesUsageIteration {
  type: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  [key: string]: unknown;
}

// The beta usage union includes model attempts, advisor attempts, and
// compaction entries, and remains additively extensible. Floway only needs an
// isolated opaque snapshot, not a closed projection of those variants.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/messages/messages.ts#L1724-L1829
export const cloneMessagesUsageIterations = (iterations: MessagesUsageIteration[] | null): MessagesUsageIteration[] | null =>
  iterations === null ? null : structuredClone(iterations);

export interface MessagesUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // Per-TTL split for cache writes introduced by extended-cache-ttl-2025-04-11.
  // Each `ephemeral_*` field is a disjoint subset of `cache_creation_input_tokens`
  // (the legacy flat field is the sum of both); upstreams that have not opted
  // into the beta omit `cache_creation` entirely and emit only the flat field.
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  // `thinking_tokens` is the reasoning subset of the inclusive `output_tokens`
  // total, re-tokenized from the raw reasoning rather than from the possibly
  // summarized thinking text that reaches the response body, so it can differ
  // from the model's own generation count by a few tokens.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts#L1292-L1304
  output_tokens_details?: { thinking_tokens: number };
  // https://docs.claude.com/en/api/service-tiers
  service_tier?: 'standard' | 'priority' | 'batch' | (string & {});
  // https://docs.claude.com/en/build-with-claude/fast-mode
  speed?: 'standard' | 'fast' | (string & {});
  server_tool_use?: MessagesUsageServerToolUse;
  iterations?: MessagesUsageIteration[] | null;
}

export interface MessagesCacheCreationUsage {
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface MessagesUsageSnapshot extends MessagesCacheCreationUsage {
  input_tokens?: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens: number };
  service_tier?: string;
  speed?: string;
  iterations?: MessagesUsageIteration[] | null;
}

export const messagesUsageSnapshot = (usage?: MessagesUsageSnapshot): MessagesUsageSnapshot => usage === undefined
  ? { output_tokens: 0 }
  : {
      ...usage,
      ...(usage.cache_creation === undefined ? {} : { cache_creation: { ...usage.cache_creation } }),
      ...(usage.output_tokens_details === undefined ? {} : { output_tokens_details: { ...usage.output_tokens_details } }),
      ...(usage.iterations === undefined ? {} : { iterations: cloneMessagesUsageIterations(usage.iterations) }),
    };

export const mergeMessagesUsageSnapshot = (
  current: MessagesUsageSnapshot,
  delta: MessagesUsageSnapshot,
): MessagesUsageSnapshot => ({
  ...current,
  output_tokens: delta.output_tokens,
  ...(delta.input_tokens === undefined ? {} : { input_tokens: delta.input_tokens }),
  ...(delta.cache_read_input_tokens === undefined ? {} : { cache_read_input_tokens: delta.cache_read_input_tokens }),
  ...(delta.cache_creation_input_tokens === undefined ? {} : { cache_creation_input_tokens: delta.cache_creation_input_tokens }),
  ...(delta.cache_creation === undefined ? {} : { cache_creation: { ...delta.cache_creation } }),
  ...(delta.output_tokens_details === undefined ? {} : { output_tokens_details: { ...delta.output_tokens_details } }),
  ...(delta.iterations === undefined ? {} : { iterations: cloneMessagesUsageIterations(delta.iterations) }),
  ...(delta.speed === undefined && delta.service_tier === undefined
    ? {}
    : { speed: delta.speed, service_tier: delta.service_tier }),
});

export const splitMessagesCacheCreationTokens = (
  usage: MessagesCacheCreationUsage,
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
