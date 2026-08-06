import type { Context } from 'hono';

import { modelsRefreshTarget, refreshModels } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { logInfo } from '@floway-dev/provider-claude-code';

export interface UpstreamModelsChange {
  previous: StoredUpstreamRecord | null;
  next: UpstreamRecord;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface SavedUpstream {
  record: StoredUpstreamRecord;
  modelsChanged: boolean;
}

const saveUpstreamForModels = async ({ previous, next }: UpstreamModelsChange): Promise<SavedUpstream> => {
  const upstreams = getRepo().upstreams;
  if (previous === null) {
    const inserted = await upstreams.insertForModels(next);
    if (!inserted) throw new Error(`Upstream ${next.id} changed concurrently`);
    return { record: inserted, modelsChanged: true };
  }
  const saved = await upstreams.replaceForModels({ previous, upstream: next });
  if (!saved) throw new Error(`Upstream ${next.id} changed concurrently`);
  return { record: saved, modelsChanged: saved.configVersion !== previous.configVersion };
};

export const saveUpstreamsAndWarmChangedModels = async (
  changes: readonly UpstreamModelsChange[],
  c: Context,
): Promise<ReadonlyMap<string, StoredUpstreamRecord>> => {
  if (new Set(changes.map(change => change.next.id)).size !== changes.length) {
    throw new Error('Duplicate upstream ids in models save batch');
  }
  if (changes.length === 0) return new Map();
  const saved: SavedUpstream[] = [];
  for (const change of changes) saved.push(await saveUpstreamForModels(change));
  const recordsToWarm = saved.filter(result => result.modelsChanged).map(result => result.record);
  if (recordsToWarm.length === 0) return new Map(saved.map(result => [result.record.id, result.record]));

  const runtimeLocation = getRuntimeLocation(c.req.raw);
  const warmedEntries = await Promise.all(recordsToWarm.map(async record => {
    try {
      await refreshModels(modelsRefreshTarget(record), runtimeLocation);
    } catch (error) {
      logInfo('warm_models_cache_failed', { upstream_id: record.id, error: errorMessage(error) });
    }
    const refreshed = await getRepo().upstreams.getById(record.id);
    if (refreshed === null) throw new Error(`Upstream ${record.id} disappeared after warm`);
    return [record.id, refreshed] as const;
  }));
  const byId = new Map(saved.map(result => [result.record.id, result.record]));
  for (const [id, record] of warmedEntries) byId.set(id, record);
  return byId;
};

export const saveUpstreamAndWarmChangedModels = async (
  change: UpstreamModelsChange,
  c: Context,
): Promise<StoredUpstreamRecord> => {
  const result = (await saveUpstreamsAndWarmChangedModels([change], c)).get(change.next.id);
  if (result === undefined) throw new Error(`Missing saved upstream result for ${change.next.id}`);
  return result;
};
