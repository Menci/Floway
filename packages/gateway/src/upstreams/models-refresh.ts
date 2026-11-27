import { createUpstream } from '../data-plane/upstreams/registry.ts';
import { createPerRequestFetcher, createValidatedPerRequestFetcher, InvalidProxyConfigurationError } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { isModelsCacheDue, MODEL_CATALOG_REVISION } from '../repo/models-cache-contract.ts';
import { modelsRefreshRetryAt } from '../repo/models-refresh-backoff.ts';
import type { StoredUpstreamRecord, UpstreamModelEntry } from '../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { UpstreamModelsUnavailableError, type Fetcher, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';
import { projectAzureModels } from '@floway-dev/upstream-azure';
import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomModels } from '@floway-dev/upstream-custom';

export type ModelsRefreshResult =
  | { readonly kind: 'discovered'; readonly entries: UpstreamModelEntry[]; readonly publication: 'published'; readonly version: number }
  | { readonly kind: 'discovered'; readonly entries: UpstreamModelEntry[]; readonly publication: 'lost-race' }
  | { readonly kind: 'backoff' | 'not-due' | 'superseded' };

export const supportsManualModels = (kind: UpstreamRecord['kind']): kind is 'custom' | 'azure' | 'ollama' =>
  kind === 'custom' || kind === 'azure' || kind === 'ollama';

export const upstreamRequiresNetworkForModels = (record: Pick<UpstreamRecord, 'kind' | 'config'>): boolean => {
  if (record.kind === 'azure') return false;
  if (record.kind === 'custom') {
    const cfg = record.config as { modelsFetch?: { enabled?: boolean } } | null | undefined;
    return cfg?.modelsFetch?.enabled !== false;
  }
  return true;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const credentialHeaders = ['authorization', 'x-api-key', 'api-key'] as const;
const credentialQueryWords = new Set(['key', 'token', 'secret', 'password', 'credential', 'auth', 'sig', 'signature']);
const isCredentialQueryParam = (name: string): boolean => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[-_]/);
  return words.some(word => credentialQueryWords.has(word))
    || /^(?:x?api|access|refresh|client|auth)(?:key|token|secret|password|credential|sig|signature)$/i.test(name);
};

const withRedactedCredentialEcho = async <T>(fetcher: Fetcher, discover: (fetcher: Fetcher) => Promise<T>): Promise<T> => {
  const credentials = new Set<string>();
  const redact = (text: string): string => {
    const variants = [...credentials].flatMap(credential => [
      credential,
      JSON.stringify(credential).slice(1, -1),
      encodeURIComponent(credential),
      new URLSearchParams({ v: credential }).toString().slice(2),
    ]);
    return [...new Set(variants)].sort((a, b) => b.length - a.length)
      .reduce((result, credential) => result.replaceAll(credential, '[REDACTED]'), text);
  };
  const trackingFetcher: Fetcher = async (url, init) => {
    const requestUrl = new URL(url, 'https://execution.floway');
    for (const encoded of [requestUrl.username, requestUrl.password]) {
      if (encoded === '') continue;
      credentials.add(encoded);
      credentials.add(new URLSearchParams(`value=${encoded}`).get('value')!);
    }
    for (const field of requestUrl.search.slice(1).split('&')) {
      if (field === '') continue;
      const [name, value] = [...new URLSearchParams(field)][0]!;
      if (!isCredentialQueryParam(name) || value === '') continue;
      credentials.add(value);
      const equals = field.indexOf('=');
      if (equals >= 0) credentials.add(field.slice(equals + 1));
    }
    const headers = new Headers(init.headers);
    for (const name of credentialHeaders) {
      const value = headers.get(name);
      if (!value) continue;
      credentials.add(value);
      if (name === 'authorization') {
        const token = /^\S+\s+(.+)$/.exec(value)?.[1];
        if (token) credentials.add(token);
      }
    }
    if (typeof init.body === 'string') {
      const contentType = headers.get('content-type');
      const refreshToken = contentType?.startsWith('application/json') && init.body.includes('"refresh_token"')
        ? (JSON.parse(init.body) as { refresh_token?: unknown }).refresh_token
        : contentType?.startsWith('application/x-www-form-urlencoded')
          ? new URLSearchParams(init.body).get('refresh_token')
          : null;
      if (typeof refreshToken === 'string' && refreshToken !== '') credentials.add(refreshToken);
    }
    const response = await fetcher(url, init);
    if (response.ok || credentials.size === 0) return response;
    const rawBody = response.body === null ? null : await response.text();
    let body: string | null = null;
    if (rawBody !== null) {
      try {
        body = redact(JSON.stringify(JSON.parse(rawBody)));
      } catch {
        body = redact(rawBody);
      }
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers([...response.headers].map(([name, value]) => [name, redact(value)])),
    });
  };
  try {
    return await discover(trackingFetcher);
  } catch (error) {
    if (error instanceof Error && credentials.size > 0) {
      error.message = redact(error.message);
      if (error.stack !== undefined) error.stack = redact(error.stack);
      if (error instanceof UpstreamModelsUnavailableError && error.cause instanceof Error) {
        error.cause.message = redact(error.cause.message);
        if (error.cause.stack !== undefined) error.cause.stack = redact(error.cause.stack);
      }
    }
    throw error;
  }
};

export const modelsRefreshErrorMessage = (error: unknown): string => {
  if (error instanceof UpstreamModelsUnavailableError) {
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

const tagModelEntries = (
  kind: UpstreamRecord['kind'],
  manualModels: readonly UpstreamModelConfig[],
  models: readonly UpstreamModel[],
): UpstreamModelEntry[] => {
  if (kind === 'azure') return models.map(model => ({ source: 'manual', model }));
  if (kind !== 'custom' && kind !== 'ollama') return models.map(model => ({ source: 'auto', model }));
  const manualUpstreamIds = new Set(manualModels.map(model => model.upstreamModelId));
  return models.map(model => ({
    source: manualUpstreamIds.has(model.upstreamModelId) ? 'manual' : 'auto',
    model,
  }));
};

const discoverModels = async (
  record: UpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
  fetcher: Fetcher,
): Promise<UpstreamModel[]> => await withRedactedCredentialEcho(fetcher, async trackedFetcher => {
  if (record.kind === 'custom') {
    const custom = assertCustomUpstreamRecord(record);
    const response = await fetchCustomModels(custom.config, trackedFetcher);
    return projectCustomModels(record, manualModels, response);
  }
  return [...await createUpstream(record).instance.getModels(trackedFetcher, manualModels)];
});

const runSavedRefresh = async (input: {
  readonly upstreamId: string;
  readonly version: number;
  readonly mode: 'automatic' | 'explicit';
  readonly runtimeLocation: string | null;
}): Promise<ModelsRefreshResult> => {
  const repo = getRepo();
  const record = await repo.upstreams.getById(input.upstreamId);
  if (record === null || record.version !== input.version) return { kind: 'superseded' };

  const requiresNetwork = upstreamRequiresNetworkForModels(record);
  const now = Date.now();
  if (input.mode === 'automatic' && !isModelsCacheDue(record.modelsCache, now, requiresNetwork)) {
    return { kind: 'not-due' };
  }
  if (input.mode === 'automatic' && record.modelsCache.lastError && modelsRefreshRetryAt(record.modelsCache.lastError) > now) {
    return { kind: 'backoff' };
  }

  const manualModels = supportsManualModels(record.kind)
    ? await repo.upstreamModels.listManualModels(record.id)
    : [];

  let models: UpstreamModel[];
  try {
    if (!requiresNetwork) {
      models = record.kind === 'azure'
        ? projectAzureModels(record, manualModels)
        : projectCustomModels(record, manualModels);
    } else {
      const createFetcher = input.mode === 'explicit' ? createValidatedPerRequestFetcher : createPerRequestFetcher;
      const fetcher = (await createFetcher(input.runtimeLocation, [record]))(record.id);
      models = await discoverModels(record, manualModels, fetcher);
    }
  } catch (error) {
    if (input.mode === 'explicit' && isModelsRefreshConfigurationError(error)) throw error;
    try {
      await repo.upstreams.recordModelsRefreshFailure({
        id: record.id,
        version: input.version,
        error: { message: modelsRefreshErrorMessage(error), at: Date.now() },
      });
    } catch (recordError) {
      throw new AggregateError([error, recordError], modelsRefreshErrorMessage(error));
    }
    throw error;
  }

  const entries = tagModelEntries(record.kind, manualModels, models);
  const publishedVersion = await repo.upstreams.publishModelsRefresh({
    id: record.id,
    version: input.version,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: entries,
  });
  return publishedVersion === null
    ? { kind: 'discovered', entries, publication: 'lost-race' }
    : { kind: 'discovered', entries, publication: 'published', version: publishedVersion };
};

export const refreshModels = (
  target: { readonly upstreamId: string; readonly version: number },
  runtimeLocation: string | null,
): Promise<ModelsRefreshResult> =>
  runSavedRefresh({ ...target, mode: 'automatic', runtimeLocation });

export const refreshModelsExplicit = (
  target: { readonly upstreamId: string; readonly version: number },
  runtimeLocation: string | null,
): Promise<ModelsRefreshResult> =>
  runSavedRefresh({ ...target, mode: 'explicit', runtimeLocation });

export const scheduleUpstreamModelsRefresh = (
  record: Pick<StoredUpstreamRecord, 'id' | 'kind' | 'enabled' | 'version' | 'config'>,
  runtimeLocation: string | null,
  scheduler: BackgroundScheduler,
): void => {
  if (!record.enabled || !upstreamRequiresNetworkForModels(record)) return;
  scheduler(
    refreshModels({ upstreamId: record.id, version: record.version }, runtimeLocation)
      .catch(error => console.error(`[models-refresh] background refresh failed for ${record.id}`, error)),
  );
};
