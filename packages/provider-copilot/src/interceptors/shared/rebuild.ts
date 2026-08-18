// Rebuilding a payload instead of writing into one.
//
// A boundary interceptor is handed the record's own value, and the record is frozen — a fact
// that could be edited after the event is not a fact. So a rule that shapes the outgoing
// payload returns a new one rather than reaching into the old, and every provider here
// already does that at the top level: `ctx.payload = { ...ctx.payload, … }`.
//
// What these two add is the same discipline one level down, without paying for a copy of the
// whole tree. A rewrite that changed nothing hands the same object back, so an untouched
// message or block rides through by identity and only the path that actually changed is
// rebuilt — which is what keeps a long conversation costing a handful of objects rather than
// a full clone, and is the same rule the record itself is folded by.

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
