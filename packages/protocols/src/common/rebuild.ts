// Rebuilding a value instead of writing into one.
//
// A record's values are frozen — a fact that could be edited after the event is not a fact — so
// anything that shapes a payload it was handed returns a new one. What these two add is the
// discipline one level down, without paying for a copy of the whole tree: a rewrite that changed
// nothing hands the same object back, so an untouched message or block rides through by identity
// and only the path that actually changed is new. That is the same rule the record itself is
// folded by, and it is what keeps a long conversation costing a handful of objects rather than a
// clone per candidate.

/** Applies `rewrite` to every item, and hands back the original array when none of them
 *  changed — so "nothing happened here" is the same test at every level. */
export const mapKeepingIdentity = <T>(items: readonly T[], rewrite: (item: T) => T): readonly T[] => {
  let changed = false;
  const next = items.map(item => {
    const rewritten = rewrite(item);
    if (rewritten !== item) changed = true;
    return rewritten;
  });
  return changed ? next : items;
};

/** The object form: rebuild with `patch` applied, or hand back the original when the patch is
 *  empty. `undefined` in the patch removes the key, which is what a rest-destructuring would
 *  do and what `delete` used to do in place. */
export const withKeysChanged = <T extends object>(source: T, patch: Readonly<Record<string, unknown>>): T => {
  const keys = Object.keys(patch);
  if (keys.length === 0) return source;
  const next: Record<string, unknown> = { ...(source as Record<string, unknown>) };
  for (const key of keys) {
    if (patch[key] === undefined) delete next[key];
    else next[key] = patch[key];
  }
  return next as T;
};

/** An array with one index replaced, or removed where the replacement is `null`. Every other
 *  element rides through by identity, and an index nobody replaced leaves the array itself
 *  untouched. */
export const withIndexesChanged = <T>(items: readonly T[], replacements: ReadonlyMap<number, T | null>): readonly T[] => {
  if (replacements.size === 0) return items;
  const next: T[] = [];
  items.forEach((item, index) => {
    if (!replacements.has(index)) { next.push(item); return; }
    const replacement = replacements.get(index)!;
    if (replacement !== null) next.push(replacement);
  });
  return next;
};
