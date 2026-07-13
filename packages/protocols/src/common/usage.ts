// Symbol-keyed billing facts survive in-process translation and reassembly but
// are omitted by JSON serialization, so protocol clients see only native fields.
export const USAGE_BILLING = Symbol('usage-billing');

export interface UsageBillingMetadata {
  cacheWriteTokenCount?: number;
  cacheWrite1hTokenCount?: number;
  serviceTier?: string;
}

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
