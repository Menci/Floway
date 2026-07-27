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

const cloneMessagesUsageIterations = (iterations: MessagesUsageIteration[] | null): MessagesUsageIteration[] | null =>
  iterations?.map(iteration => ({
    ...iteration,
    ...(iteration.cache_creation === undefined || iteration.cache_creation === null
      ? {}
      : { cache_creation: { ...iteration.cache_creation } }),
  })) ?? null;

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
  service_tier?: string;
  speed?: string;
  iterations?: MessagesUsageIteration[] | null;
}

export const messagesUsageSnapshot = (usage?: MessagesUsageSnapshot): MessagesUsageSnapshot => usage === undefined
  ? { output_tokens: 0 }
  : {
      ...usage,
      ...(usage.cache_creation === undefined ? {} : { cache_creation: { ...usage.cache_creation } }),
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
