import type { GatewayProvider } from './registry.ts';
import { getRepo } from '../../repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';
import { serializeStoredConfig } from '../../repo/upstream-json.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { runProviderModelsTask, type Fetcher, type ProviderModel, type UpstreamModelsCache } from '@floway-dev/provider';

// Soft TTL: a fetched row is served verbatim within this window with no
// upstream call. Past SOFT but within HARD, the stored row is still served
// while a background revalidate refreshes it. Past HARD a fresh fetch is
// required and blocks the caller; a failed background revalidate within
// HARD leaves the row in place and only annotates the entry's `lastError`,
// which is also the rationale for treating SOFT/HARD as a single SWR window
// rather than introducing a separate fail-back tier.
const SOFT_MS = 10 * 60 * 1000;
const HARD_MS = 24 * 60 * 60 * 1000;

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

export interface ModelsCacheFetchOptions {
  scheduler: BackgroundScheduler;
  fetcher: Fetcher;
  // Skip the SOFT/HARD cache check and always trigger a fresh fetch. The
  // call still joins the L1 in-flight map when both fetch identity and cache
  // ownership match. Failure throws; no fall-back to the stored row.
  force?: boolean;
  // Some control-plane callers also need the upstream's raw catalog shape.
  // Their loader projects that already-fetched response into the exact
  // ProviderModel catalog the provider would otherwise return, avoiding a
  // second upstream request while keeping cache writes in this module.
  loadProvidedModels?: (signal: AbortSignal) => Promise<ProviderModel[]>;
}

interface ModelsFetchResult {
  readonly models: ProviderModel[];
  readonly persistedCache: UpstreamModelsCache | null;
}

interface InFlightModelsFetch {
  readonly promise: Promise<ProviderModel[]>;
  readonly instances: Set<GatewayProvider>;
  backgroundScheduled: boolean;
}

// L1: per-isolate in-flight memoization. Callers join only when both their
// actual fetch inputs and persisted-cache ownership match; different drafts
// and superseded rows remain isolated. Every joining provider instance receives
// the cache snapshot committed by the shared fetch, keeping later reads in each
// request coherent. Not a TTL cache — the entry is removed when the promise
// settles. The conditional delete defends against a stale removal racing a
// later replacement.
const inFlight = new Map<string, InFlightModelsFetch>();

const memoInFlight = (
  key: string,
  instance: GatewayProvider,
  fn: () => Promise<ModelsFetchResult>,
): InFlightModelsFetch => {
  const existing = inFlight.get(key);
  if (existing) {
    existing.instances.add(instance);
    return existing;
  }

  const instances = new Set([instance]);
  const promise = fn().then(result => {
    if (result.persistedCache !== null) {
      for (const joined of instances) joined.modelsCache = result.persistedCache;
    }
    return result.models;
  });
  const entry: InFlightModelsFetch = { promise, instances, backgroundScheduled: false };
  inFlight.set(key, entry);
  promise.finally(() => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  }).catch(() => {});
  return entry;
};

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

const assertUniqueModelIds = (instance: GatewayProvider, models: ProviderModel[]): ProviderModel[] => {
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.id) continue;
    if (seen.has(model.id)) {
      throw new Error(`Upstream '${instance.upstreamId}' returned duplicate model id '${model.id}'`);
    }
    seen.add(model.id);
  }
  return models;
};

const runFetch = (
  instance: GatewayProvider,
  fetcher: Fetcher,
  key: string,
  loadProvidedModels?: (signal: AbortSignal) => Promise<ProviderModel[]>,
): Promise<ModelsFetchResult> => runProviderModelsTask(async signal => {
  const generation = instance.modelsCacheGeneration;
  try {
    const loaded = loadProvidedModels === undefined
      ? instance.instance.getProvidedModels({ fetcher, signal })
      : loadProvidedModels(signal);
    const models = assertUniqueModelIds(instance, [...await loaded]);
    const entry = { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null };
    const persisted = await getRepo().upstreams.saveModelsCache(key, generation, entry);
    return { models, persistedCache: persisted ? entry : null };
  } catch (err) {
    // A no-op on an upstream with no cached catalog: a brand-new upstream that
    // fails its first fetch surfaces the error to the caller with nothing
    // persisted.
    await getRepo().upstreams.saveModelsCacheError(key, generation, { message: errorMessage(err), at: Date.now() });
    throw err;
  }
});

export const fetchUpstreamModelsCached = async (
  instance: GatewayProvider,
  opts: ModelsCacheFetchOptions,
): Promise<ProviderModel[]> => {
  const { scheduler, fetcher, force, loadProvidedModels } = opts;
  const key = instance.upstreamId;
  const generation = instance.modelsCacheGeneration;
  const inFlightKey = `${key}\0${instance.modelsFetchIdentity}\0${generation.updatedAt}\0${serializeStoredConfig(generation.config)}`;
  const now = Date.now();

  if (force) {
    return await memoInFlight(inFlightKey, instance, () => runFetch(instance, fetcher, key, loadProvidedModels)).promise;
  }

  // Read off the instance rather than queried: the row that produced this
  // provider carried its catalog, so the SWR check costs nothing.
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;

  if (cached && now - cached.fetchedAt < SOFT_MS) {
    return assertUniqueModelIds(instance, cached.models);
  }

  if (cached && now - cached.fetchedAt < HARD_MS) {
    const inFlightFetch = memoInFlight(inFlightKey, instance, () => runFetch(instance, fetcher, key));
    if (!inFlightFetch.backgroundScheduled) {
      // The trailing `.catch` is the sink for the background branch only —
      // `runFetch` already persists the failure via `saveModelsCacheError`
      // before rethrowing, so the SWR caller who got `cached.models` does not
      // need to learn about it.
      scheduler(inFlightFetch.promise.catch(() => {}));
      inFlightFetch.backgroundScheduled = true;
    }
    return assertUniqueModelIds(instance, cached.models);
  }

  return await memoInFlight(inFlightKey, instance, () => runFetch(instance, fetcher, key)).promise;
};

// Test-only: drop the L1 map so a test's setup is independent of any
// promise the previous test left mid-settle.
export const clearInFlightForTesting = (): void => {
  inFlight.clear();
};
