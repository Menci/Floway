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

// Symbol-keyed billing facts survive in-process translation and reassembly but
// are omitted by JSON serialization, so protocol clients see only native fields.
export const USAGE_BILLING = Symbol('usage-billing');

export interface UsageBillingMetadata {
  cacheWriteTokenCount?: number;
  cacheWrite1hTokenCount?: number;
  serviceTier?: string;
}

export const splitCacheWriteTokens = (
  totalCacheWriteTokens: number | undefined,
  billing: UsageBillingMetadata | undefined,
): { cacheWrite: number; cacheWrite1h: number } => {
  const cacheWrite1h = billing?.cacheWrite1hTokenCount ?? 0;
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
