import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher, createValidatedPerRequestFetcher, InvalidProxyConfigurationError, validateUpstreamProxyConfiguration } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../repo/models-cache-contract.ts';
import type { StoredUpstreamRecord } from '../repo/types.ts';
import { getExecutionCellNamespace } from '../runtime/execution.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { ProviderModelsUnavailableError, type Fetcher, type ProviderModel, type UpstreamModelConfig } from '@floway-dev/provider';
import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomDiscoveredModels, projectCustomModels } from '@floway-dev/provider-custom';

export interface ModelsRefreshExecutionInput {
  upstreamId: string;
  configVersion: number;
  cacheEpoch: number;
  runtimeLocation: string | null;
  mode: 'automatic' | 'explicit';
}

export type ModelsRefreshExecutionResult = ({
  mode: ModelsRefreshExecutionInput['mode'];
} & (
  | { kind: 'refreshed'; discovered?: UpstreamModelConfig[] }
  | { kind: 'backoff' | 'superseded' }
));

export type ModelsRefreshTarget = Pick<ModelsRefreshExecutionInput, 'upstreamId' | 'configVersion' | 'cacheEpoch'>;
export type ModelsRefreshScheduler = (target: ModelsRefreshTarget) => void;

class ModelsRefreshUnavailableError extends ProviderModelsUnavailableError {
  constructor(readonly mode: ModelsRefreshExecutionInput['mode']) {
    super(null);
  }
}

const cacheEpoch = (record: Pick<StoredUpstreamRecord, 'modelsCache'>): number => record.modelsCache?.fetchedAt ?? 0;

export const modelsRefreshTarget = (record: StoredUpstreamRecord): ModelsRefreshTarget => ({
  upstreamId: record.id,
  configVersion: record.configVersion,
  cacheEpoch: cacheEpoch(record),
});

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const isModelsRefreshConfigurationError = (error: unknown): error is InvalidProxyConfigurationError =>
  error instanceof InvalidProxyConfigurationError;

export const executeModelsRefresh = async (input: ModelsRefreshExecutionInput): Promise<ModelsRefreshExecutionResult> => {
  const repo = getRepo().upstreams;
  const record = await repo.getById(input.upstreamId);
  if (record === null
    || record.configVersion !== input.configVersion
    || cacheEpoch(record) !== input.cacheEpoch) return { kind: 'superseded', mode: input.mode };

  const beginning = await repo.beginModelsRefresh({
    id: record.id,
    configVersion: input.configVersion,
    cacheEpoch: input.cacheEpoch,
    now: Date.now(),
    bypassBackoff: input.mode === 'explicit',
  });
  if (beginning.kind !== 'ready') return { ...beginning, mode: input.mode };

  try {
    const createFetcher = input.mode === 'explicit' ? createValidatedPerRequestFetcher : createPerRequestFetcher;
    const fetcher: Fetcher = (await createFetcher(input.runtimeLocation, [record]))(record.id);
    let models: ProviderModel[];
    let discovered: UpstreamModelConfig[] | undefined;
    if (record.kind === 'custom') {
      const custom = assertCustomUpstreamRecord(record);
      if (input.mode === 'explicit' || custom.config.modelsFetch.enabled) {
        const response = await fetchCustomModels(custom.config, fetcher);
        models = projectCustomModels(record, response);
        discovered = projectCustomDiscoveredModels(record, response);
      } else {
        models = projectCustomModels(record);
      }
    } else {
      models = [...await createProvider(record).instance.getProvidedModels(fetcher)];
    }
    const published = await repo.publishModelsRefresh({
      id: record.id,
      configVersion: input.configVersion,
      cacheEpoch: input.cacheEpoch,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Math.max(Date.now(), input.cacheEpoch + 1), models },
    });
    return published
      ? { kind: 'refreshed', mode: input.mode, ...(discovered ? { discovered } : {}) }
      : { kind: 'superseded', mode: input.mode };
  } catch (error) {
    if (input.mode === 'explicit' && isModelsRefreshConfigurationError(error)) throw error;
    const failedAt = Date.now();
    try {
      await repo.recordModelsRefreshFailure({
        id: record.id,
        configVersion: input.configVersion,
        cacheEpoch: input.cacheEpoch,
        error: { message: errorMessage(error), at: failedAt },
        previousFailureCount: beginning.failureCount,
        failedAt,
      });
    } catch (recordError) {
      throw new AggregateError([error, recordError], errorMessage(error));
    }
    throw error;
  }
};

const executeThroughCell = async (input: ModelsRefreshExecutionInput): Promise<ModelsRefreshExecutionResult> => {
  const cellId = JSON.stringify(['models', input.upstreamId, input.configVersion, input.cacheEpoch]);
  const response = await getExecutionCellNamespace().fetch(cellId, new Request('https://execution.floway/models/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
  if (response.ok) return await response.json() as ModelsRefreshExecutionResult;
  const error = await response.json() as { kind?: unknown; message?: unknown; mode?: unknown };
  if (response.status === 502 && error.kind === 'provider-unavailable' && (error.mode === 'automatic' || error.mode === 'explicit')) {
    throw new ModelsRefreshUnavailableError(error.mode);
  }
  if (response.status === 400 && error.kind === 'invalid-configuration' && typeof error.message === 'string') {
    throw new InvalidProxyConfigurationError(error.message);
  }
  throw new Error(`Unexpected models refresh execution response: HTTP ${response.status}`);
};

export const refreshModels = (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
): Promise<ModelsRefreshExecutionResult> => executeThroughCell({ ...target, runtimeLocation, mode: 'automatic' });

export const refreshModelsExplicit = async (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
  requiresDiscovery: boolean,
): Promise<ModelsRefreshExecutionResult> => {
  let current = target;
  while (true) {
    let superseded = false;
    try {
      const result = await executeThroughCell({ ...current, runtimeLocation, mode: 'explicit' });
      if (result.kind !== 'superseded' && result.mode !== 'automatic') return result;
      if (result.kind === 'refreshed' && (!requiresDiscovery || result.discovered !== undefined)) {
        const record = await getRepo().upstreams.getById(target.upstreamId);
        if (record === null || record.configVersion !== target.configVersion) return { kind: 'superseded', mode: 'explicit' };
        await validateUpstreamProxyConfiguration(runtimeLocation, record);
        return result;
      }
      superseded = result.kind === 'superseded';
    } catch (error) {
      if (!(error instanceof ModelsRefreshUnavailableError) || error.mode !== 'automatic') throw error;
    }
    const record = await getRepo().upstreams.getById(target.upstreamId);
    if (record === null || record.configVersion !== target.configVersion) return { kind: 'superseded', mode: 'explicit' };
    const next = modelsRefreshTarget(record);
    if (superseded && next.cacheEpoch === current.cacheEpoch) return { kind: 'superseded', mode: 'explicit' };
    current = next;
  }
};

export const createModelsRefreshScheduler = (
  runtimeLocation: string | null,
  scheduler: BackgroundScheduler,
): ModelsRefreshScheduler => target => {
  scheduler(refreshModels(target, runtimeLocation));
};
