import { getRepo } from '../../repo/index.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, Provider, ProviderModel } from '@floway-dev/provider';

// Soft TTL: a fetched row is served verbatim within this window with no
// upstream call. Past SOFT but within HARD, the stored row is still served
// while a background revalidate refreshes it. Past HARD a fresh fetch is
// required and blocks the caller; a failed background revalidate within
// HARD leaves the row in place and only annotates the entry's `lastError`,
// which is also the rationale for treating SOFT/HARD as a single SWR window
// rather than introducing a separate fail-back tier.
const SOFT_MS = 10 * 60 * 1000;
const HARD_MS = 24 * 60 * 60 * 1000;

// Persisted ProviderModel rows contain code-derived metadata as well as the
// upstream response. Increment this whenever that derived catalog contract or
// its serialization changes so older rows become cold across deployments.
export const MODEL_CATALOG_REVISION = 5;

export interface ModelsCacheFetchOptions {
  scheduler: BackgroundScheduler;
  fetcher: Fetcher;
  // Skip the SOFT/HARD cache check and always trigger a fresh fetch. The
  // call still joins the L1 in-flight map so concurrent forces share a
  // single upstream request. Failure throws; no fall-back to the stored
  // row.
  force?: boolean;
  // Some control-plane callers also need the upstream's raw catalog shape.
  // Their loader projects that already-fetched response into the exact
  // ProviderModel catalog the provider would otherwise return, avoiding a
  // second upstream request while keeping cache writes in this module.
  loadProvidedModels?: () => Promise<ProviderModel[]>;
}

// L1: per-isolate in-flight memoization. Collapses concurrent callers for
// the same upstream onto a single upstream fetch. Not a TTL cache — the
// entry is removed when the promise settles. The conditional delete
// defends against a stale removal racing a later replacement.
const inFlight = new Map<string, Promise<ProviderModel[]>>();

const memoInFlight = (
  key: string,
  fn: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => {
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
  instance: Provider,
  fetcher: Fetcher,
  key: string,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => {
  try {
    const models = [...await (loadProvidedModels?.() ?? instance.instance.getProvidedModels(fetcher))];
    const entry = { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null };
    await getRepo().upstreams.saveModelsCache(key, entry);
    // The instance carries the row as it was read at request start, and a
    // request reaches this function more than once -- once per alias target
    // resolved. Writing the entry back keeps every later read in the request
    // seeing what was just persisted, which is what re-querying the row used
    // to give us.
    instance.modelsCache = entry;
    return models;
  } catch (err) {
    // A no-op on an upstream with no cached catalog: a brand-new upstream that
    // fails its first fetch surfaces the error to the caller with nothing
    // persisted.
    await getRepo().upstreams.saveModelsCacheError(key, { message: errorMessage(err), at: Date.now() });
    throw err;
  }
};

export const fetchUpstreamModelsCached = async (
  instance: Provider,
  opts: ModelsCacheFetchOptions,
): Promise<ProviderModel[]> => {
  const { scheduler, fetcher, force, loadProvidedModels } = opts;
  const key = instance.upstreamId;
  const now = Date.now();

  if (force) {
    return await memoInFlight(key, () => runFetch(instance, fetcher, key, loadProvidedModels));
  }

  // Read off the instance rather than queried: the row that produced this
  // provider carried its catalog, so the SWR check costs nothing.
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;

  if (cached && now - cached.fetchedAt < SOFT_MS) {
    return cached.models;
  }

  if (cached && now - cached.fetchedAt < HARD_MS) {
    // Joining L1 here means a second request arriving mid-flight does
    // not enqueue a second background task. The trailing `.catch` is the
    // sink for the background branch only — `runFetch` already persists
    // the failure via `saveModelsCacheError` before rethrowing, so the SWR
    // caller who got `cached.models` does not need to learn about it.
    scheduler(memoInFlight(key, () => runFetch(instance, fetcher, key)).catch(() => {}));
    return cached.models;
  }

  return await memoInFlight(key, () => runFetch(instance, fetcher, key));
};

// Test-only: drop the L1 map so a test's setup is independent of any
// promise the previous test left mid-settle.
export const clearInFlightForTesting = (): void => {
  inFlight.clear();
};
