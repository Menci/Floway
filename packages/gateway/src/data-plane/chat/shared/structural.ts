
/** Removing a field inside a value is the same move as removing a fact, and a value that
 *  carried none of them comes back by identity so the rule costs nothing where it does not
 *  apply. */
export const withoutKeys = <T extends object>(value: T, keys: readonly (keyof T)[]): T => {
  if (!keys.some(key => key in value)) return value;
  const removed = new Set<string>(keys as readonly string[]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !removed.has(key))) as T;
};

/** `map`, but the array comes back by identity when every element did. Written once because
 *  every rule here walks a list of something — messages, input items, content parts — and
 *  the identity is the whole reason a layer costs only what it actually changed. */
export const mapKeepingIdentity = <T>(items: T[], rewrite: (item: T) => T): T[] => {
  let changed = false;
  const mapped = items.map(item => {
    const next = rewrite(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? mapped : items;
};
