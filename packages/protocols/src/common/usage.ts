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
