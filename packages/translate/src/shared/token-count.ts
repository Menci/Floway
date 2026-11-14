export const requireTokenCount = (name: string, value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${name} must be a non-negative safe integer: ${String(value)}`);
  return value as number;
};
