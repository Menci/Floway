import { HTTPException } from 'hono/http-exception';

import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export interface UpstreamChange {
  previous: StoredUpstreamRecord | null;
  next: UpstreamRecord;
}

export const saveUpstream = async ({ previous, next }: UpstreamChange): Promise<StoredUpstreamRecord> => {
  const upstreams = getRepo().upstreams;
  const saved = previous === null
    ? await upstreams.insertForModels(next)
    : await upstreams.replaceForModels({ previous, upstream: next });
  if (saved === null) throw new HTTPException(409, { message: `Upstream ${next.id} changed concurrently` });
  return saved;
};

export const saveUpstreams = async (changes: readonly UpstreamChange[]): Promise<void> => {
  for (const change of changes) await saveUpstream(change);
};
