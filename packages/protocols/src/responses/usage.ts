// Responses input_tokens includes both cache-read and cache-write subsets.
// Every consumer must enforce the same disjointness invariant: malformed cache
// splits are protocol errors, not absent usage and never values to clamp.
export const splitResponsesInputTokens = (
  inputTokens: number,
  cachedTokens: number | undefined,
  cacheWriteTokens: number | undefined,
): { input: number; cacheRead: number; cacheWrite: number } => {
  for (const [name, value] of [
    ['input_tokens', inputTokens],
    ['cached_tokens', cachedTokens],
    ['cache_write_tokens', cacheWriteTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`Responses ${name} must be a non-negative safe integer: ${value}`);
    }
  }
  const cacheRead = cachedTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const input = inputTokens - cacheRead - cacheWrite;
  if (input < 0) {
    throw new RangeError(`Responses cache token counts exceed input_tokens: ${inputTokens} - ${cacheRead} - ${cacheWrite}`);
  }
  return { input, cacheRead, cacheWrite };
};
