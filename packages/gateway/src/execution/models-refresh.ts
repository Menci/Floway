import { createPreviewProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher, createValidatedPerRequestFetcher, InvalidProxyConfigurationError } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { MODEL_CATALOG_REVISION, shouldScheduleModelsRefresh } from '../repo/models-cache-contract.ts';
import { modelsRefreshRetryAt } from '../repo/models-refresh-backoff.ts';
import { modelsRefreshInputHash, modelsRefreshInputs } from '../repo/models-refresh-inputs.ts';
import type { StoredUpstreamRecord } from '../repo/types.ts';
import { getExecutionCellNamespace } from '../runtime/execution.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { ProviderModelsUnavailableError, type Fetcher, type ProviderModel, type ProviderModelsFailureResponse, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomDiscoveredModels, projectCustomModels } from '@floway-dev/provider-custom';

export type ModelsRefreshExecutionInput =
  | { kind: 'saved'; upstreamId: string; configVersion: number; inputHash: string; mode: 'automatic' | 'explicit'; runtimeLocation: string | null }
  | { kind: 'draft'; record: UpstreamRecord; runtimeLocation: string | null; nonce: string };

export type ModelsRefreshExecutionResult =
  | { kind: 'discovered'; models: ProviderModel[]; discovered?: UpstreamModelConfig[]; publication: 'published' | 'lost-race' | 'draft' }
  | { kind: 'backoff' | 'not-due' | 'superseded' };

export type ModelsRefreshTarget = Pick<Extract<ModelsRefreshExecutionInput, { kind: 'saved' }>, 'upstreamId' | 'configVersion' | 'inputHash'>;
export type ModelsRefreshScheduler = (target: ModelsRefreshTarget) => void;

type WireProviderModel = Omit<ProviderModel, 'enabledFlags'> & { enabledFlags: FlagId[] };
type WireResult = Exclude<ModelsRefreshExecutionResult, { kind: 'discovered' }>
  | (Omit<Extract<ModelsRefreshExecutionResult, { kind: 'discovered' }>, 'models'> & { models: WireProviderModel[] });

export const encodeModelsRefreshResult = (result: ModelsRefreshExecutionResult): WireResult => result.kind === 'discovered'
  ? { ...result, models: result.models.map(model => ({ ...model, enabledFlags: [...model.enabledFlags] })) }
  : result;

const decodeModelsRefreshResult = (result: WireResult): ModelsRefreshExecutionResult => result.kind === 'discovered'
  ? { ...result, models: result.models.map(model => ({ ...model, enabledFlags: new Set(model.enabledFlags) })) }
  : result;

export const modelsRefreshTarget = (record: StoredUpstreamRecord): ModelsRefreshTarget => ({
  upstreamId: record.id,
  configVersion: record.configVersion,
  inputHash: modelsRefreshInputHash(record),
});

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const credentialHeaders = ['authorization', 'x-api-key', 'api-key'] as const;

const withRedactedCredentialEcho = async <T>(fetcher: Fetcher, discover: (fetcher: Fetcher) => Promise<T>): Promise<T> => {
  const credentials = new Set<string>();
  const trackingFetcher: Fetcher = async (url, init) => {
    const headers = new Headers(init.headers);
    for (const name of credentialHeaders) {
      const value = headers.get(name);
      if (!value) continue;
      credentials.add(value);
      if (name === 'authorization') {
        const token = /^(?:Bearer|Basic)\s+(\S+)/i.exec(value)?.[1];
        if (token) credentials.add(token);
      }
    }
    return await fetcher(url, init);
  };
  try {
    return await discover(trackingFetcher);
  } catch (error) {
    if (!(error instanceof ProviderModelsUnavailableError) || error.displayResponse === null || credentials.size === 0) throw error;
    const redact = (text: string): string => [...credentials].sort((a, b) => b.length - a.length)
      .reduce((result, credential) => result.replaceAll(credential, '[REDACTED]'), text);
    throw new ProviderModelsUnavailableError(error.httpResponse, error, {
      ...error.displayResponse,
      headers: error.displayResponse.headers.map(([name, value]) => [name, redact(value)]),
      body: redact(error.displayResponse.body),
    });
  }
};

export const modelsRefreshErrorMessage = (error: unknown): string => {
  if (error instanceof ProviderModelsUnavailableError) {
    if (error.displayResponse !== null) {
      const body = error.displayResponse.body.trim();
      const summary = body === '' ? `HTTP ${error.displayResponse.status}` : `HTTP ${error.displayResponse.status}: ${body}`;
      const headers = error.displayResponse.headers.map(([name, value]) => `${name}: ${value}`).join('\n');
      return headers === '' ? summary : `${summary}\n\n${headers}`;
    }
    if (error.cause !== undefined) return errorMessage(error.cause);
  }
  return errorMessage(error);
};
export const isModelsRefreshConfigurationError = (error: unknown): error is InvalidProxyConfigurationError =>
  error instanceof InvalidProxyConfigurationError;

const discoverModels = async (record: UpstreamRecord, fetcher: Fetcher, fetchCustomLive: boolean): Promise<{
  models: ProviderModel[];
  discovered?: UpstreamModelConfig[];
}> => await withRedactedCredentialEcho(fetcher, async trackedFetcher => {
  if (record.kind === 'custom') {
    const custom = assertCustomUpstreamRecord(record);
    if (!fetchCustomLive && !custom.config.modelsFetch.enabled) return { models: projectCustomModels(record) };
    const response = await fetchCustomModels(custom.config, trackedFetcher);
    return { models: projectCustomModels(record, response), discovered: projectCustomDiscoveredModels(record, response) };
  }
  return { models: [...await createPreviewProvider(record).instance.getProvidedModels(trackedFetcher)] };
});

export const executeModelsRefresh = async (input: ModelsRefreshExecutionInput): Promise<ModelsRefreshExecutionResult> => {
  const repo = getRepo().upstreams;
  if (input.kind === 'draft') {
    if (input.record.kind !== 'custom' && input.record.kind !== 'ollama') throw new TypeError('Draft model discovery requires custom or ollama');
    const fetcher = (await createValidatedPerRequestFetcher(input.runtimeLocation, [input.record]))(input.record.id);
    return { kind: 'discovered', ...await discoverModels(input.record, fetcher, true), publication: 'draft' };
  }

  const record = await repo.getById(input.upstreamId);
  if (record === null || record.configVersion !== input.configVersion || modelsRefreshInputHash(record) !== input.inputHash) return { kind: 'superseded' };
  if (input.mode === 'automatic' && !shouldScheduleModelsRefresh(record.modelsCache, Date.now())) return { kind: 'not-due' };
  const epoch = record.modelsCache?.fetchedAt ?? 0;
  const previousFailureCount = record.modelsCache?.lastError?.failureCount ?? 0;
  if (input.mode === 'automatic' && record.modelsCache?.lastError
    && modelsRefreshRetryAt(record.modelsCache.lastError) > Date.now()) return { kind: 'backoff' };

  let result: Awaited<ReturnType<typeof discoverModels>>;
  try {
    const createFetcher = input.mode === 'explicit' ? createValidatedPerRequestFetcher : createPerRequestFetcher;
    const fetcher = (await createFetcher(input.runtimeLocation, [record]))(record.id);
    result = await discoverModels(record, fetcher, input.mode === 'explicit');
  } catch (error) {
    if (input.mode === 'explicit' && isModelsRefreshConfigurationError(error)) throw error;
    try {
      await repo.recordModelsRefreshFailure({
        id: record.id,
        configVersion: input.configVersion,
        cacheEpoch: epoch,
        refreshInputs: modelsRefreshInputs(record),
        error: { message: modelsRefreshErrorMessage(error), at: Date.now() },
        previousFailureCount,
      });
    } catch (recordError) {
      throw new AggregateError([error, recordError], modelsRefreshErrorMessage(error));
    }
    throw error;
  }
  const published = await repo.publishModelsRefresh({
    id: record.id,
    configVersion: input.configVersion,
    cacheEpoch: epoch,
    refreshInputs: modelsRefreshInputs(record),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Math.max(Date.now(), epoch + 1), models: result.models },
  });
  return { kind: 'discovered', ...result, publication: published ? 'published' : 'lost-race' };
};

const executeThroughCell = async (input: ModelsRefreshExecutionInput): Promise<ModelsRefreshExecutionResult> => {
  const cellId = input.kind === 'saved'
    ? JSON.stringify(['models', 'saved', input.upstreamId, input.configVersion, input.inputHash, input.mode, input.runtimeLocation])
    : JSON.stringify(['models', 'draft', input.nonce]);
  const response = await getExecutionCellNamespace().fetch(cellId, new Request('https://execution.floway/models/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }));
  if (response.ok) return decodeModelsRefreshResult(await response.json() as WireResult);
  const error = await response.json() as { kind?: unknown; message?: unknown; upstreamResponse?: ProviderModelsFailureResponse | null };
  if (response.status === 502 && error.kind === 'provider-unavailable' && typeof error.message === 'string') {
    throw new ProviderModelsUnavailableError(null, new Error(error.message), error.upstreamResponse);
  }
  if (response.status === 400 && error.kind === 'invalid-configuration' && typeof error.message === 'string') {
    throw new InvalidProxyConfigurationError(error.message);
  }
  throw new Error(`Unexpected models refresh execution response: HTTP ${response.status}`);
};

export const refreshModels = (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
): Promise<ModelsRefreshExecutionResult> => executeThroughCell({ kind: 'saved', ...target, runtimeLocation, mode: 'automatic' });

export const refreshModelsExplicit = (
  target: ModelsRefreshTarget,
  runtimeLocation: string | null,
): Promise<ModelsRefreshExecutionResult> => executeThroughCell({ kind: 'saved', ...target, runtimeLocation, mode: 'explicit' });

export const discoverDraftModels = (
  record: UpstreamRecord,
  runtimeLocation: string | null,
): Promise<ModelsRefreshExecutionResult> => executeThroughCell({ kind: 'draft', record, runtimeLocation, nonce: crypto.randomUUID() });

export const createModelsRefreshScheduler = (
  runtimeLocation: string | null,
  scheduler: BackgroundScheduler,
): ModelsRefreshScheduler => target => {
  scheduler(refreshModels(target, runtimeLocation));
};
