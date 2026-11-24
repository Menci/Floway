// Serializes with every object's keys sorted, so two values that differ only in
// the order their keys were written compare equal.
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).toSorted().map(key => [key, (item as Record<string, unknown>)[key]]))
    : item);
