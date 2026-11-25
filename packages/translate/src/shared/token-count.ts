export const requireTokenCount = (name: string, value: unknown, InvalidCount: new (message: string) => Error = RangeError): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InvalidCount(`${name} must be a non-negative safe integer: ${String(value)}`);
  return value as number;
};
