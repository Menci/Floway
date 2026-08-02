export const toggledSeries = (hidden: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export const invertedSeries = (ids: readonly string[], hidden: ReadonlySet<string>): Set<string> =>
  new Set(ids.filter(id => !hidden.has(id)));

// Isolating the only visible series has nowhere left to go, so the same
// gesture reverses it instead of being a one-way trip.
export const isolatedSeries = (ids: readonly string[], hidden: ReadonlySet<string>, id: string): Set<string> => {
  const visible = ids.filter(candidate => !hidden.has(candidate));
  return visible.length === 1 && visible[0] === id
    ? new Set()
    : new Set(ids.filter(candidate => candidate !== id));
};
