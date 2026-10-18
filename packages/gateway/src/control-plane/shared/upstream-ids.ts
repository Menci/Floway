import { getRepo } from '../../repo/index.ts';

type UpstreamIdsValue = string[] | null;

type ParseUpstreamIdsResult =
  | { ok: true; value: UpstreamIdsValue }
  | { ok: false; error: string };

export const parseUpstreamIdsValue = (raw: unknown): ParseUpstreamIdsResult => {
  if (raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: 'upstream_ids must be null or an array of upstream ids' };

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

// Stored key restrictions can retain deleted IDs, so responses project them
// through the known upstream inventory. Preserve [] as an explicit restriction:
// null only removes key-level narrowing; Model.Use grants still apply.
export const pruneUnknownUpstreamIds = (
  ids: readonly string[] | null,
  known: ReadonlySet<string>,
): string[] | null => ids === null ? null : ids.filter(id => known.has(id));
