export interface UserUpstreamAccessChange {
  upstreamId: string;
  allowed: boolean;
}

export const applyUserUpstreamAccessChanges = (
  current: readonly string[] | null,
  catalogIds: readonly string[],
  changes: readonly UserUpstreamAccessChange[],
): string[] | null => {
  const changeById = new Map(changes.map(change => [change.upstreamId, change.allowed]));
  if (current === null) {
    const denied = new Set(changes.filter(change => !change.allowed).map(change => change.upstreamId));
    return denied.size === 0 ? null : catalogIds.filter(id => !denied.has(id));
  }

  const retained = current.filter(id => changeById.get(id) !== false);
  const retainedIds = new Set(retained);
  return [
    ...retained,
    ...catalogIds.filter(id => changeById.get(id) === true && !retainedIds.has(id)),
  ];
};
