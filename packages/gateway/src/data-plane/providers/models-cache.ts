import type { GatewayProvider } from './registry.ts';
import { getRepo } from '../../repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';
import { MODELS_REFRESH_CLAIM_LEASE_MS, modelsRefreshRetryAt } from '../../repo/models-refresh-contract.ts';
import { serializeStoredConfig } from '../../repo/upstream-json.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, ProviderModel } from '@floway-dev/provider';

// Soft-fresh rows need no refresh. Every older row remains usable forever;
// access only triggers a background attempt guarded by the persisted refresh
// claim/backoff state.
const SOFT_MS = 10 * 60 * 1000;
const ACTIVE_REFRESH_POLL_MS = 100;

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

export interface ModelsCacheFetchOptions {
  scheduler: BackgroundScheduler;
  fetcher: Fetcher;
  // The upstream editor's explicit Fetch Models action is the sole caller of
  // this option. It waits for an actual fetch and bypasses refresh backoff.
  force?: boolean;
  // Some control-plane callers also need the upstream's raw catalog shape.
  // Their loader projects that already-fetched response into the exact
  // ProviderModel catalog the provider would otherwise return, avoiding a
  // second upstream request while keeping cache writes in this module.
  loadProvidedModels?: () => Promise<ProviderModel[]>;
}

// L1: per-isolate in-flight memoization. Callers join only when both their
// actual fetch inputs and persisted-cache ownership match; different drafts
// and superseded rows remain isolated. Not a TTL cache — the entry is removed
// when the promise settles. The conditional delete defends against a stale
// removal racing a later replacement.
type RefreshMode = 'fetch' | 'warm' | 'trigger';

interface InFlightRefresh {
  kind: 'fetch' | 'wait';
  promise: Promise<ProviderModel[] | null>;
}

const inFlight = new Map<string, InFlightRefresh>();

const startInFlight = (
  key: string,
  kind: InFlightRefresh['kind'],
  fn: () => Promise<ProviderModel[] | null>,
): Promise<ProviderModel[] | null> => {
  const entry: InFlightRefresh = { kind, promise: fn() };
  inFlight.set(key, entry);
  entry.promise.finally(() => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  }).catch(() => {});
  return entry.promise;
};

const memoInFlight = (
  key: string,
  kind: InFlightRefresh['kind'],
  fn: () => Promise<ProviderModel[] | null>,
): Promise<ProviderModel[] | null> => {
  const existing = inFlight.get(key);
  return existing?.promise ?? startInFlight(key, kind, fn);
};

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

const runFetch = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => [...await (loadProvidedModels?.() ?? instance.instance.getProvidedModels(fetcher))];

const runClaimedFetch = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  mode: RefreshMode,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
  initialObservedActiveToken: string | null = null,
): Promise<ProviderModel[] | null> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  let observedActiveToken = initialObservedActiveToken;
  let claimed: Extract<Awaited<ReturnType<typeof repo.upstreams.claimModelsRefresh>>, { kind: 'claimed' }>;
  while (true) {
    const now = Date.now();
    const outcome = await repo.upstreams.claimModelsRefresh({
      id: instance.upstreamId,
      generation: instance.modelsCacheGeneration,
      token,
      now,
      staleClaimedBefore: now - MODELS_REFRESH_CLAIM_LEASE_MS,
      force: mode === 'fetch',
      observedActiveToken,
    });
    if (outcome.kind === 'claimed') {
      claimed = outcome;
      break;
    }
    if (mode !== 'warm' || outcome.kind === 'backoff' || outcome.kind === 'generation-mismatch') return null;
    if (outcome.kind === 'completed') {
      const current = await repo.upstreams.getById(instance.upstreamId);
      if (current !== null
        && current.updatedAt === instance.modelsCacheGeneration.updatedAt
        && serializeStoredConfig(current.config) === serializeStoredConfig(instance.modelsCacheGeneration.config)) instance.modelsCache = current.modelsCache;
      return null;
    }
    observedActiveToken = outcome.token;
    await new Promise(resolve => setTimeout(resolve, ACTIVE_REFRESH_POLL_MS));
  }

  let models: ProviderModel[];
  try {
    models = await runFetch(instance, fetcher, loadProvidedModels);
  } catch (error) {
    const failureCount = claimed.failureCount + 1;
    const now = Date.now();
    const lastError = { message: errorMessage(error), at: now };
    try {
      const finalized = await repo.upstreams.finalizeModelsRefreshFailure(
        instance.upstreamId,
        instance.modelsCacheGeneration,
        token,
        lastError,
        failureCount,
        modelsRefreshRetryAt(now, claimed.failureCount),
      );
      if (finalized) {
        if (instance.modelsCache) instance.modelsCache.lastError = lastError;
        else instance.modelsCache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 0, models: [], lastError };
      }
      if (!finalized && mode === 'warm') {
        const winner = await runClaimedFetch(instance, fetcher, 'warm', loadProvidedModels, token);
        return winner ?? instance.modelsCache?.models ?? [];
      }
    } catch (backoffError) {
      throw new AggregateError([error, backoffError], errorMessage(error));
    }
    throw error;
  }
  const entry = { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null };
  const finalized = await repo.upstreams.finalizeModelsRefreshSuccess(
    instance.upstreamId,
    instance.modelsCacheGeneration,
    token,
    entry,
  );
  // The instance is reused across alias targets in one request, so publish the
  // finalized snapshot locally as well as durably.
  if (finalized) instance.modelsCache = entry;
  else if (mode === 'warm') {
    const winner = await runClaimedFetch(instance, fetcher, 'warm', loadProvidedModels, token);
    return winner ?? instance.modelsCache?.models ?? [];
  }
  return models;
};

const inFlightKey = (instance: GatewayProvider): string => {
  const generation = instance.modelsCacheGeneration;
  return `${instance.upstreamId}\0${instance.modelsFetchIdentity}\0${generation.updatedAt}\0${serializeStoredConfig(generation.config)}`;
};

export const fetchUpstreamModels = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => {
  const key = inFlightKey(instance);
  const existing = inFlight.get(key);
  if (existing?.kind === 'fetch') {
    const joined = await existing.promise;
    if (joined !== null) return joined;
    if (inFlight.get(key) === existing) inFlight.delete(key);
  }

  const models = await startInFlight(key, 'fetch', () => runClaimedFetch(instance, fetcher, 'fetch', loadProvidedModels));
  if (models === null) throw new Error(`Failed to force-claim models refresh for ${instance.upstreamId}`);
  return models;
};

export const warmUpstreamModels = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => {
  const key = inFlightKey(instance);
  const existing = inFlight.get(key);
  if (existing) {
    const joined = await existing.promise;
    if (joined !== null) return joined;
    if (inFlight.get(key) === existing) inFlight.delete(key);
  }

  const models = await memoInFlight(key, 'wait', () => runClaimedFetch(instance, fetcher, 'warm', loadProvidedModels));
  return models ?? instance.modelsCache?.models ?? [];
};

export const triggerUpstreamModelsFetch = (
  instance: GatewayProvider,
  scheduler: BackgroundScheduler,
  fetcher: Fetcher,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): void => {
  const key = inFlightKey(instance);
  scheduler(memoInFlight(key, 'fetch', () => runClaimedFetch(instance, fetcher, 'trigger', loadProvidedModels)).then(() => {}));
};

export const fetchUpstreamModelsCached = async (
  instance: GatewayProvider,
  opts: ModelsCacheFetchOptions,
): Promise<ProviderModel[]> => {
  const { scheduler, fetcher, force, loadProvidedModels } = opts;
  const now = Date.now();

  if (force) {
    return await fetchUpstreamModels(instance, fetcher, loadProvidedModels);
  }

  // Read off the instance rather than queried: the row that produced this
  // provider carried its catalog, so the SWR check costs nothing.
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;

  if (cached && now - cached.fetchedAt < SOFT_MS) return cached.models;

  triggerUpstreamModelsFetch(instance, scheduler, fetcher, loadProvidedModels);
  return cached?.models ?? [];
};

// Test-only: drop the L1 map so a test's setup is independent of any
// promise the previous test left mid-settle.
export const clearInFlightForTesting = (): void => {
  inFlight.clear();
};
