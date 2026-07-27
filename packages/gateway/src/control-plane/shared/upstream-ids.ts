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

export const validateUpstreamIdsExist = async (ids: readonly string[] | null): Promise<string | null> => {
  if (ids === null) return null;
  const upstreams = await getRepo().upstreams.list();
  const known = new Set(upstreams.map(upstream => upstream.id));
  const unknown = ids.filter(id => !known.has(id));
  return unknown.length ? `Unknown upstream(s): ${unknown.join(', ')}` : null;
};
