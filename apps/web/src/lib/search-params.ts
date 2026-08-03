// A search parameter is whatever the address bar carries, so a value outside
// the set the page knows is read as absent rather than trusted.
export const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  value !== null && (allowed as readonly string[]).includes(value) ? value as T : fallback;
