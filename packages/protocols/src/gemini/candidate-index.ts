export const assertGeminiCandidateIndex = (index: unknown): asserts index is number => {
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`Gemini candidate index must be a non-negative safe integer: ${String(index)}`);
  }
};
