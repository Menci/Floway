import type { Context } from 'hono';

import { warmUpstreamModels } from '../../data-plane/providers/models-refresh.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { logInfo } from '@floway-dev/provider-claude-code';

export interface UpstreamModelsChange {
  previous: UpstreamRecord | null;
  next: UpstreamRecord;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const saveUpstreamForModels = async ({ previous, next }: UpstreamModelsChange): Promise<void> => {
  const upstreams = getRepo().upstreams;
  if (previous === null) {
    const inserted = await upstreams.insertForModels(next);
    if (!inserted) throw new Error(`Upstream ${next.id} changed concurrently`);
    return;
  }
  const saved = await upstreams.replaceForModels({ previous, upstream: next });
  if (!saved) throw new Error(`Upstream ${next.id} changed concurrently`);
};

export const saveAndWarmUpstreamsForModels = async (
  changes: readonly UpstreamModelsChange[],
  c: Context,
): Promise<ReadonlyMap<string, UpstreamRecord>> => {
  if (new Set(changes.map(change => change.next.id)).size !== changes.length) {
    throw new Error('Duplicate upstream ids in models save batch');
  }
  for (const change of changes) await saveUpstreamForModels(change);
  if (changes.length === 0) return new Map();

  const records = await Promise.all(changes.map(async change => {
    const record = await getRepo().upstreams.getById(change.next.id);
    if (record === null) throw new Error(`Upstream ${change.next.id} disappeared after save`);
    return record;
  }));
  const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw), records);
  const entries = await Promise.all(records.map(async record => {
    try {
      await warmUpstreamModels(createProvider(record), fetcherForUpstream(record.id));
    } catch (error) {
      logInfo('warm_models_cache_failed', { upstream_id: record.id, error: errorMessage(error) });
    }
    const refreshed = await getRepo().upstreams.getById(record.id);
    if (refreshed === null) throw new Error(`Upstream ${record.id} disappeared after warm`);
    return [record.id, refreshed] as const;
  }));
  return new Map(entries);
};

export const saveAndWarmUpstreamForModels = async (
  change: UpstreamModelsChange,
  c: Context,
): Promise<UpstreamRecord> => {
  const result = (await saveAndWarmUpstreamsForModels([change], c)).get(change.next.id);
  if (result === undefined) throw new Error(`Missing saved upstream result for ${change.next.id}`);
  return result;
};
