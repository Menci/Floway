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
}

export const messagesUsageSnapshot = (usage?: MessagesUsageSnapshot): MessagesUsageSnapshot => usage === undefined
  ? { output_tokens: 0 }
  : {
      ...usage,
      ...(usage.cache_creation === undefined ? {} : { cache_creation: { ...usage.cache_creation } }),
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
