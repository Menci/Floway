import { warmUpstreamModels } from '../data-plane/providers/models-refresh.ts';
import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import type { StoredUpstreamRecord } from '../repo/types.ts';
import { getExecutionCellNamespace } from '../runtime/execution.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export interface ModelsRefreshExecutionInput {
  upstreamId: string;
  configVersion: number;
  cacheEpoch: number | null;
  runtimeLocation: string | null;
}

export const executeModelsRefresh = async (input: ModelsRefreshExecutionInput): Promise<void> => {
  const record = await getRepo().upstreams.getById(input.upstreamId);
  if (record === null
    || record.configVersion !== input.configVersion
    || (record.modelsCache?.fetchedAt ?? null) !== input.cacheEpoch) return;
  const fetcherForUpstream = await createPerRequestFetcher(input.runtimeLocation, [record]);
  await warmUpstreamModels(createProvider(record), fetcherForUpstream(record.id));
};

export const scheduleModelsRefreshExecution = (
  record: StoredUpstreamRecord,
  runtimeLocation: string | null,
  scheduler: BackgroundScheduler,
): void => {
  const cacheEpoch = record.modelsCache?.fetchedAt ?? null;
  const cellId = `models:${record.id}:${record.configVersion}:${cacheEpoch ?? 'cold'}`;
  const input: ModelsRefreshExecutionInput = {
    upstreamId: record.id,
    configVersion: record.configVersion,
    cacheEpoch,
    runtimeLocation,
  };
  const execution = getExecutionCellNamespace().fetch(cellId, new Request('https://execution.floway/models/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })).then(async response => {
    if (response.ok) return;
    throw new Error(`Models refresh execution failed with HTTP ${response.status}: ${await response.text()}`);
  }).catch(error => {
    console.error(`[models] refresh execution failed for ${record.id}`, error);
    throw error;
  });
  scheduler(execution);
};
