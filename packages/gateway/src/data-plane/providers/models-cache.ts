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
const inFlight = new Map<string, Promise<ProviderModel[] | null>>();

const memoInFlight = (
  key: string,
  fn: () => Promise<ProviderModel[] | null>,
): Promise<ProviderModel[] | null> => {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fn();
  inFlight.set(key, promise);
  promise.finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }).catch(() => {});
  return promise;
};

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

const runFetch = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  key: string,
  token: string,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => {
  const generation = instance.modelsCacheGeneration;
  try {
    const models = [...await (loadProvidedModels?.() ?? instance.instance.getProvidedModels(fetcher))];
    const entry = { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null };
    const persisted = await getRepo().upstreams.saveClaimedModelsCache(key, generation, token, entry);
    // The instance carries the row as it was read at request start, and a
    // request reaches this function more than once -- once per alias target
    // resolved. Writing the entry back keeps every later read in the request
    // seeing what was just persisted, which is what re-querying the row used
    // to give us.
    if (persisted) instance.modelsCache = entry;
    return models;
  } catch (err) {
    const lastError = { message: errorMessage(err), at: Date.now() };
    const persisted = await getRepo().upstreams.saveClaimedModelsCacheError(key, generation, token, lastError);
    if (persisted) {
      if (instance.modelsCache) instance.modelsCache.lastError = lastError;
      else instance.modelsCache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 0, models: [], lastError };
    }
    throw err;
  }
};

const runClaimedFetch = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  force: boolean,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[] | null> => {
  const repo = getRepo();
  const now = Date.now();
  const token = crypto.randomUUID();
  const claimed = await repo.upstreams.claimModelsRefresh(
    instance.upstreamId,
    instance.modelsCacheGeneration,
    token,
    now,
    now - MODELS_REFRESH_CLAIM_LEASE_MS,
    force,
  );
  if (claimed === null) return null;

  try {
    const models = await runFetch(instance, fetcher, instance.upstreamId, token, loadProvidedModels);
    await repo.upstreams.completeModelsRefreshSuccess(instance.upstreamId, token);
    return models;
  } catch (error) {
    try {
      const failureCount = claimed.failureCount + 1;
      const now = Date.now();
      await repo.upstreams.completeModelsRefreshFailure(instance.upstreamId, token, failureCount, modelsRefreshRetryAt(now, claimed.failureCount));
    } catch (backoffError) {
      throw new AggregateError([error, backoffError], errorMessage(error));
    }
    throw error;
  }
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
  if (existing) {
    const joined = await existing;
    if (joined !== null) return joined;
    if (inFlight.get(key) === existing) inFlight.delete(key);
  }

  const models = await memoInFlight(key, () => runClaimedFetch(instance, fetcher, true, loadProvidedModels));
  if (models === null) throw new Error(`Failed to force-claim models refresh for ${instance.upstreamId}`);
  return models;
};

export const triggerUpstreamModelsFetch = (
  instance: GatewayProvider,
  scheduler: BackgroundScheduler,
  fetcher: Fetcher,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): void => {
  const key = inFlightKey(instance);
  scheduler(memoInFlight(key, () => runClaimedFetch(instance, fetcher, false, loadProvidedModels)).then(() => {}));
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
