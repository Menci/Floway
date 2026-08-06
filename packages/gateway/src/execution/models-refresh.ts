import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { MODEL_CATALOG_REVISION, modelsCacheGeneration } from '../repo/models-cache-contract.ts';
import type { StoredUpstreamRecord } from '../repo/types.ts';
import { getExecutionCellNamespace } from '../runtime/execution.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { ProviderModelsUnavailableError, type ProviderModel, type UpstreamModelConfig } from '@floway-dev/provider';
import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomDiscoveredModels, projectCustomModels } from '@floway-dev/provider-custom';

export interface ModelsRefreshExecutionInput {
  upstreamId: string;
  configVersion: number;
  cacheEpoch: number | null;
  runtimeLocation: string | null;
  bypassBackoff: boolean;
  includeDiscovered: boolean;
}

export type ModelsRefreshExecutionResult =
  | { kind: 'refreshed'; discovered?: UpstreamModelConfig[] }
  | { kind: 'backoff' | 'generation-mismatch' };

interface ModelsRefreshExecutionError {
  kind: 'provider-unavailable' | 'error';
  message: string;
}

export type ModelsRefreshTarget = Pick<ModelsRefreshExecutionInput, 'upstreamId' | 'configVersion' | 'cacheEpoch'>;

const cacheEpoch = (record: Pick<StoredUpstreamRecord, 'modelsCache'>): number | null => {
  const fetchedAt = record.modelsCache?.fetchedAt;
  return fetchedAt === undefined || fetchedAt === 0 ? null : fetchedAt;
};

export const modelsRefreshTarget = (record: StoredUpstreamRecord): ModelsRefreshTarget => ({
  upstreamId: record.id,
  configVersion: record.configVersion,
  cacheEpoch: cacheEpoch(record),
});

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const executeModelsRefresh = async (input: ModelsRefreshExecutionInput): Promise<ModelsRefreshExecutionResult> => {
  const repo = getRepo().upstreams;
  const record = await repo.getById(input.upstreamId);
  if (record === null
    || record.configVersion !== input.configVersion
    || cacheEpoch(record) !== input.cacheEpoch) return { kind: 'generation-mismatch' };

  const generation = modelsCacheGeneration(record);
  const beginning = await repo.beginModelsRefresh({
    id: record.id,
    generation,
    now: Date.now(),
    bypassBackoff: input.bypassBackoff,
  });
  if (beginning.kind !== 'ready') return beginning;

  try {
    const fetcher = (await createPerRequestFetcher(input.runtimeLocation, [record]))(record.id);
    let models: ProviderModel[];
    let discovered: UpstreamModelConfig[] | undefined;
    if (record.kind === 'custom' && input.includeDiscovered) {
      const response = await fetchCustomModels(assertCustomUpstreamRecord(record).config, fetcher);
      models = projectCustomModels(record, response);
      discovered = projectCustomDiscoveredModels(record, response);
    } else {
      models = [...await createProvider(record).instance.getProvidedModels(fetcher)];
    }
    const published = await repo.publishModelsRefresh({
      id: record.id,
      generation,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models },
    });
    return published ? { kind: 'refreshed', ...(discovered ? { discovered } : {}) } : { kind: 'generation-mismatch' };
  } catch (error) {
    const failedAt = Date.now();
    await repo.recordModelsRefreshFailure({
      id: record.id,
      generation,
      error: { message: errorMessage(error), at: failedAt },
      previousFailureCount: beginning.failureCount,
      failedAt,
    });
    throw error;
  }
};

const executionInput = (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
  options: Pick<ModelsRefreshExecutionInput, 'bypassBackoff' | 'includeDiscovered'>,
): ModelsRefreshExecutionInput => ({
  ...target,
  runtimeLocation,
  ...options,
});

const executeThroughCell = async (input: ModelsRefreshExecutionInput): Promise<ModelsRefreshExecutionResult> => {
  const cellId = `models:${input.upstreamId}:${input.configVersion}:${input.cacheEpoch ?? 'cold'}`;
  const response = await getExecutionCellNamespace().fetch(cellId, new Request('https://execution.floway/models/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
  if (response.ok) return await response.json() as ModelsRefreshExecutionResult;
  const error = await response.json() as ModelsRefreshExecutionError;
  if (error.kind === 'provider-unavailable') throw new ProviderModelsUnavailableError(null);
  throw new Error(error.message);
};

export const refreshModels = async (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
  options: Pick<ModelsRefreshExecutionInput, 'bypassBackoff' | 'includeDiscovered'>,
): Promise<ModelsRefreshExecutionResult> => {
  const input = executionInput(target, runtimeLocation, options);
  const result = await executeThroughCell(input);
  return options.bypassBackoff && result.kind === 'backoff' ? await executeThroughCell(input) : result;
};

export const scheduleModelsRefresh = (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
  scheduler: BackgroundScheduler,
): void => {
  scheduler(refreshModels(target, runtimeLocation, { bypassBackoff: false, includeDiscovered: false }).then(() => {}));
};

export const modelsRefreshExecutionError = (error: unknown): ModelsRefreshExecutionError => ({
  kind: error instanceof ProviderModelsUnavailableError ? 'provider-unavailable' : 'error',
  message: errorMessage(error),
});
