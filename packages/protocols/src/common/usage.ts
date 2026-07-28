// Response-side `default` (OpenAI), `standard` (Anthropic), and blank values
// identify base service. Other open-string values remain byte-preserving.
// https://developers.openai.com/api/docs/guides/priority-processing
// https://docs.claude.com/en/api/service-tiers
// https://docs.claude.com/en/build-with-claude/fast-mode
export const billableServiceTier = (tier: string | null | undefined): string | null => {
  if (tier == null) return null;
  const normalized = tier.trim().toLowerCase();
  return normalized === '' || normalized === 'default' || normalized === 'standard' ? null : tier;
};

// The complete, canonical view of what an upstream turn cost, read from that
// upstream's own usage in its own protocol. Pricing reads this and nothing
// else — in particular it never reads the usage Floway sends the client, which
// is a wire projection whose protocol may have no field for a bucket we are
// billed for: an Anthropic 1-hour cache write reaching a Responses client, or
// a cache-write count or service tier reaching Gemini, which has neither.
//
// Counts are exclusive — `input` excludes `cacheRead` and both cache-write
// buckets — because that is how the buckets are priced, rather than how any
// one protocol happens to report its totals.
export interface BillableUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning?: number;
  tier?: string;
}

export const splitCacheWriteTokens = (
  totalCacheWriteTokens: number | undefined,
  cacheWrite1h: number,
): { cacheWrite: number; cacheWrite1h: number } => {
  if (!Number.isSafeInteger(cacheWrite1h) || cacheWrite1h < 0) {
    throw new RangeError(`1-hour cache-write tokens must be a non-negative safe integer: ${cacheWrite1h}`);
  }
  if (totalCacheWriteTokens === undefined) {
    if (cacheWrite1h > 0) throw new RangeError('1-hour cache-write tokens require a total cache-write count');
    return { cacheWrite: 0, cacheWrite1h: 0 };
  }
  if (!Number.isSafeInteger(totalCacheWriteTokens) || totalCacheWriteTokens < 0) {
    throw new RangeError(`total cache-write tokens must be a non-negative safe integer: ${totalCacheWriteTokens}`);
  }
  if (cacheWrite1h > totalCacheWriteTokens) {
    throw new RangeError('1-hour cache-write tokens exceed total cache-write tokens');
  }
  return { cacheWrite: totalCacheWriteTokens - cacheWrite1h, cacheWrite1h };
};

export const splitInclusiveInputTokens = (
  inputTokens: number,
  cacheReadTokens: number | undefined,
  cacheWriteTokens: number | undefined,
): { input: number; cacheRead: number; cacheWrite: number } => {
  for (const [name, value] of [
    ['input tokens', inputTokens],
    ['cache-read tokens', cacheReadTokens],
    ['cache-write tokens', cacheWriteTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative safe integer: ${value}`);
    }
  }
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const input = inputTokens - cacheRead - cacheWrite;
  if (input < 0) {
    throw new RangeError(`cache token counts exceed inclusive input tokens: ${inputTokens} - ${cacheRead} - ${cacheWrite}`);
  }
  return { input, cacheRead, cacheWrite };
};

export const splitInclusiveOutputTokens = (
  outputTokens: number,
  reasoningTokens: number | undefined,
): { output: number; reasoning: number } => {
  for (const [name, value] of [
    ['output tokens', outputTokens],
    ['reasoning tokens', reasoningTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative safe integer: ${value}`);
    }
  }
  const reasoning = reasoningTokens ?? 0;
  const output = outputTokens - reasoning;
  if (output < 0) throw new RangeError(`reasoning tokens exceed inclusive output tokens: ${outputTokens} - ${reasoning}`);
  return { output, reasoning };
};
