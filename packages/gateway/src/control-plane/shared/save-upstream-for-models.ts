import type { Context } from 'hono';

import { MODEL_LISTING_FAILURE_MESSAGE } from '../../data-plane/models/shared.ts';
import { modelsRefreshTarget, refreshModels } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { reshapeModelForDashboard } from '../upstreams/models.ts';
import { ProviderModelsUnavailableError, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
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

export type SavedModelDiscovery =
  | { kind: 'success'; data: UpstreamModelConfig[] | null }
  | { kind: 'failure'; message: string; upstreamListingFailed: boolean };

export interface SavedUpstreamOutcome {
  record: StoredUpstreamRecord;
  modelDiscovery: SavedModelDiscovery | null;
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
): Promise<ReadonlyMap<string, SavedUpstreamOutcome>> => {
  if (new Set(changes.map(change => change.next.id)).size !== changes.length) {
    throw new Error('Duplicate upstream ids in models save batch');
  }
  if (changes.length === 0) return new Map();
  const saved: SavedUpstream[] = [];
  for (const change of changes) saved.push(await saveUpstreamForModels(change));
  const recordsToWarm = saved.filter(result => result.modelsChanged).map(result => result.record);
  const byId = new Map<string, SavedUpstreamOutcome>(saved.map(result => [result.record.id, { record: result.record, modelDiscovery: null }]));
  if (recordsToWarm.length === 0) return byId;

  const runtimeLocation = getRuntimeLocation(c.req.raw);
  const warmedEntries = await Promise.all(recordsToWarm.map(async record => {
    let modelDiscovery: SavedModelDiscovery;
    try {
      const result = await refreshModels(modelsRefreshTarget(record), runtimeLocation);
      if (result.kind === 'discovered') {
        modelDiscovery = {
          kind: 'success',
          data: record.kind === 'custom' ? result.discovered ?? null : result.models.map(reshapeModelForDashboard),
        };
      } else {
        modelDiscovery = { kind: 'failure', message: 'Upstream changed during models refresh', upstreamListingFailed: false };
      }
    } catch (error) {
      logInfo('warm_models_cache_failed', { upstream_id: record.id, error: errorMessage(error) });
      const upstreamListingFailed = error instanceof ProviderModelsUnavailableError;
      modelDiscovery = { kind: 'failure', message: upstreamListingFailed ? MODEL_LISTING_FAILURE_MESSAGE : errorMessage(error), upstreamListingFailed };
    }
    const refreshed = await getRepo().upstreams.getById(record.id);
    if (refreshed === null) throw new Error(`Upstream ${record.id} disappeared after warm`);
    if (refreshed.configVersion !== record.configVersion) {
      modelDiscovery = { kind: 'failure', message: 'Upstream changed during models refresh', upstreamListingFailed: false };
    }
    return [record.id, { record: refreshed, modelDiscovery }] as const;
  }));
  for (const [id, outcome] of warmedEntries) byId.set(id, outcome);
  return byId;
};

export const saveUpstreamAndWarmChangedModels = async (
  change: UpstreamModelsChange,
  c: Context,
): Promise<SavedUpstreamOutcome> => {
  const result = (await saveUpstreamsAndWarmChangedModels([change], c)).get(change.next.id);
  if (result === undefined) throw new Error(`Missing saved upstream result for ${change.next.id}`);
  return result;
};
