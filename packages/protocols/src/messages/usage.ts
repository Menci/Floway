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

export interface MessagesCacheCreationTtlTokens {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

// Cumulative whole-message counters. Every one of them but `output_tokens` is
// declared nullable upstream and carries `null` when the bucket does not apply
// to the request, while upstreams that never opted into the owning feature
// omit the field instead — the SDK's own accumulator reads both spellings as
// "no value" and overwrites only when the counter is present.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/18ea26d324911c3236f2ce762dd0c87f04d038d3/src/resources/messages/messages.ts#L1169-L1204
// https://github.com/anthropics/anthropic-sdk-typescript/blob/18ea26d324911c3236f2ce762dd0c87f04d038d3/src/lib/MessageStream.ts#L592-L616
export interface MessagesUsageDelta {
  input_tokens?: number | null;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  // Per-TTL split for cache writes introduced by extended-cache-ttl-2025-04-11.
  // Each `ephemeral_*` field is a disjoint subset of `cache_creation_input_tokens`
  // (the legacy flat field is the sum of both); upstreams that have not opted
  // into the beta omit `cache_creation` entirely and emit only the flat field.
  cache_creation?: MessagesCacheCreationTtlTokens | null;
  // `thinking_tokens` is the reasoning subset of the inclusive `output_tokens`
  // total, re-tokenized from the raw reasoning rather than from the possibly
  // summarized thinking text that reaches the response body, so it can differ
  // from the model's own generation count by a few tokens.
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts#L1292-L1304
  output_tokens_details?: { thinking_tokens: number } | null;
  // https://docs.claude.com/en/api/service-tiers
  service_tier?: 'standard' | 'priority' | 'batch' | (string & {}) | null;
  // https://docs.claude.com/en/build-with-claude/fast-mode
  speed?: 'standard' | 'fast' | (string & {}) | null;
  server_tool_use?: MessagesUsageServerToolUse | null;
  iterations?: MessagesUsageIteration[] | null;
}

// The whole-message totals, carried by the non-streaming response body and by
// the `message_start` snapshot that reuses it — the two places upstream
// declares `input_tokens` non-null. Upstream's own delta carrier declares a
// narrower field set than the type above, which stays widened because real
// upstreams do repeat the tier and per-TTL fields on `message_delta`.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/18ea26d324911c3236f2ce762dd0c87f04d038d3/src/resources/messages/messages.ts#L2362-L2412
export interface MessagesUsage extends Omit<MessagesUsageDelta, 'input_tokens'> {
  input_tokens: number;
}

export interface MessagesCacheCreationUsage {
  cache_creation_input_tokens?: number;
  cache_creation?: MessagesCacheCreationTtlTokens;
}

// Usage as Floway accounts for it: the upstream counters with every `null`
// already collapsed to absence, so consumers test presence rather than repeat
// the wire's two spellings of "no value". `iterations` keeps its explicit
// `null`, which upstream uses to state that a turn ran no iterations at all.
export interface MessagesUsageSnapshot extends MessagesCacheCreationUsage {
  input_tokens?: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens: number };
  service_tier?: string;
  speed?: string;
  iterations?: MessagesUsageIteration[] | null;
}

const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

export const messagesUsageSnapshot = (usage?: MessagesUsageDelta): MessagesUsageSnapshot => usage === undefined
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
      ...(usage.iterations === undefined ? {} : { iterations: cloneMessagesUsageIterations(usage.iterations) }),
    };

export const mergeMessagesUsageSnapshot = (
  current: MessagesUsageSnapshot,
  delta: MessagesUsageDelta,
): MessagesUsageSnapshot => {
  const update = messagesUsageSnapshot(delta);
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
