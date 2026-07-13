// Wire payloads are JSON-shaped trees. Mutable containers need an
// attempt-owned copy, while immutable primitive leaves can be reused without
// giving one candidate write access to another candidate's request. This is
// intentionally narrower than structuredClone: callers must not pass host
// objects or mutable binary leaves.
export const cloneProtocolPayload = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(cloneProtocolPayload) as T;
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(source)) cloned[key] = cloneProtocolPayload(source[key]);
  return cloned as T;
};
