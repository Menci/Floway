// Freezing every reachable object makes any in-place write by translation throw,
// so a test that translates a frozen value proves the value stays untouched.
// Typed arrays with elements cannot be frozen, so byte values are left as they are.
export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return value;
};
