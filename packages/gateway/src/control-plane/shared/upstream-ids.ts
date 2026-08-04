import { getRepo } from '../../repo/index.ts';

type UpstreamIdsValue = string[] | null;

type ParseUpstreamIdsResult =
  | { ok: true; value: UpstreamIdsValue }
  | { ok: false; error: string };

// Empty arrays are rejected: a key that allows zero upstreams cannot serve any
// model, and the UI has no affordance to express that intent.
export const parseUpstreamIdsValue = (raw: unknown): ParseUpstreamIdsResult => {
  if (raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: 'upstream_ids must be null or an array of upstream ids' };
  if (raw.length === 0) return { ok: false, error: 'upstream_ids must contain at least one upstream id; use null for Default mode' };

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) return { ok: false, error: 'upstream_ids must be non-empty strings' };
    if (seen.has(item)) return { ok: false, error: `upstream_ids contains duplicate id ${item}` };
    seen.add(item);
    ids.push(item);
  }
  return { ok: true, value: ids };
};

export const loadKnownUpstreamIds = async (): Promise<ReadonlySet<string>> =>
  new Set((await getRepo().upstreams.list()).map(upstream => upstream.id));

export const unknownUpstreamIdsError = (ids: readonly string[] | null, known: ReadonlySet<string>): string | null => {
  if (ids === null) return null;
  const unknown = ids.filter(id => !known.has(id));
  return unknown.length ? `Unknown upstream(s): ${unknown.join(', ')}` : null;
};

// Deleting an upstream leaves its id behind in every user and api-key cap that
// named it, and narrowing a user's cap leaves it behind in that user's keys —
// nothing cascades either way, and the data plane treats both as inert: it
// routes on the intersection of a key's cap with its user's. Reads project a
// stored cap through what the principal can actually reach, so the dashboard
// never renders an entry it cannot resolve and never re-submits one into the
// write path, which rejects both. A cap whose ids are all gone projects to an
// empty list: that is what it grants now. Widening it to null would read as
// "inherit" and hand the principal the entire catalog.
export const pruneUnreachableUpstreamIds = (
  ids: readonly string[] | null,
  reachable: ReadonlySet<string>,
): string[] | null => ids === null ? null : ids.filter(id => reachable.has(id));

// What a key of this user's can grant: the live catalog, capped by the user's
// own grant when they have one. `loadKnownUpstreamIds` stays the set the write
// path validates against, so an id that exists but is out of the user's reach
// still earns its own error rather than "Unknown upstream(s)".
export const reachableUpstreamIds = (
  known: ReadonlySet<string>,
  userCap: readonly string[] | null,
): ReadonlySet<string> => {
  if (userCap === null) return known;
  const cap = new Set(userCap);
  return new Set([...known].filter(id => cap.has(id)));
};
