import type { StoredUpstreamRecord } from '../../repo/types.ts';

// Requiring a scope makes an unrestricted catalog an explicit choice.
export const selectEnabledUpstreams = (
  upstreamFilter: readonly string[] | null,
  upstreams: readonly StoredUpstreamRecord[],
): StoredUpstreamRecord[] => {
  const enabledById = new Map<string, StoredUpstreamRecord>();
  for (const upstream of upstreams) {
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  // The filter is the intersection of the per-user and per-api-key caps, both
  // of which reference upstreams by id. Deleting or disabling an upstream does
  // not prune those lists, so an id that no longer resolves is inert rather
  // than fatal: it narrows the scope and drops out on the next write to the
  // user or key. The principal keeps serving on the rest of its cap; a
  // selection emptied this way is an empty catalog, not an error.
  return upstreamFilter
    ? upstreamFilter.map(id => enabledById.get(id)).filter((u): u is StoredUpstreamRecord => u !== undefined)
    : [...enabledById.values()];
};
