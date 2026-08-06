import type { GatewayProvider } from './registry.ts';
import { getRepo } from '../../repo/index.ts';
import { MODEL_CATALOG_REVISION, modelsFetchIdentity } from '../../repo/models-cache-contract.ts';
import { MODELS_REFRESH_CLAIM_LEASE_MS } from '../../repo/models-refresh-contract.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, ProviderModel, UpstreamModelsCache } from '@floway-dev/provider';

// Soft-fresh rows need no refresh. Every older row remains usable forever;
// access only triggers a background attempt guarded by the persisted refresh
// claim/backoff state.
const SOFT_MS = 10 * 60 * 1000;
const ACTIVE_REFRESH_POLL_MS = 100;
const ACTIVE_REFRESH_POLL_CAP_MS = 1_000;
const ACTIVE_REFRESH_WAIT_MS = 60_000;

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

interface ModelsSnapshotReadOptions {
  scheduler: BackgroundScheduler;
  fetcher: Fetcher;
}

interface ModelsSnapshot {
  readonly models: readonly ProviderModel[];
  readonly lastError: UpstreamModelsCache['lastError'];
}

// L1: per-isolate in-flight memoization. Callers join only when both their
// actual fetch inputs and persisted-cache ownership match; different drafts
// and superseded rows remain isolated. Not a TTL cache — the entry is removed
// when the promise settles. The conditional delete defends against a stale
// removal racing a later replacement.
type RefreshIntent = 'explicit' | 'warm' | 'background';

interface InFlightRefresh {
  kind: 'refresh' | 'owner-wait';
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

const runClaimedRefresh = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  intent: RefreshIntent,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[] | null> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  let observedActiveToken: string | null = null;
  let pollMs = ACTIVE_REFRESH_POLL_MS;
  const waitDeadline = Date.now() + ACTIVE_REFRESH_WAIT_MS;
  while (true) {
    const now = Date.now();
    const outcome = await repo.upstreams.claimModelsRefresh({
      id: instance.upstreamId,
      generation: instance.modelsCacheGeneration,
      token,
      now,
      staleClaimedBefore: now - MODELS_REFRESH_CLAIM_LEASE_MS,
      bypassBackoff: intent === 'explicit',
      observedActiveToken,
    });
    if (outcome.kind === 'backoff' || outcome.kind === 'generation-mismatch') return null;
    if (outcome.kind === 'completed') {
      const current = await repo.upstreams.getById(instance.upstreamId);
      if (current !== null
        && current.updatedAt === instance.modelsCacheGeneration.updatedAt
        && modelsFetchIdentity(current) === instance.modelsCacheGeneration.fetchIdentity) instance.modelsCache = current.modelsCache;
      if (intent === 'explicit' && instance.modelsCache?.lastError !== null && instance.modelsCache?.lastError !== undefined) {
        throw new Error(instance.modelsCache.lastError.message);
      }
      return instance.modelsCache?.models ?? [];
    }
    if (outcome.kind === 'active') {
      if (intent === 'background') return null;
      if (now >= waitDeadline) throw new Error(`Timed out waiting for models refresh owner for ${instance.upstreamId}`);
      observedActiveToken = outcome.token;
      await new Promise(resolve => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, ACTIVE_REFRESH_POLL_CAP_MS);
      continue;
    }

    let models: ProviderModel[];
    try {
      models = await runFetch(instance, fetcher, loadProvidedModels);
    } catch (error) {
      const failedAt = Date.now();
      const lastError = { message: errorMessage(error), at: failedAt };
      let finalized: boolean;
      try {
        finalized = await repo.upstreams.finalizeModelsRefreshFailure({
          id: instance.upstreamId,
          generation: instance.modelsCacheGeneration,
          token,
          error: lastError,
          previousFailureCount: outcome.failureCount,
          failedAt,
        });
      } catch (backoffError) {
        throw new AggregateError([error, backoffError], errorMessage(error));
      }
      if (finalized) {
        if (instance.modelsCache) instance.modelsCache.lastError = lastError;
        else instance.modelsCache = { revision: MODEL_CATALOG_REVISION, fetchedAt: 0, models: [], lastError };
        throw error;
      }
      if (intent === 'background') throw error;
      observedActiveToken = token;
      continue;
    }
    const entry = { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null };
    const finalized = await repo.upstreams.finalizeModelsRefreshSuccess({
      id: instance.upstreamId,
      generation: instance.modelsCacheGeneration,
      token,
      cache: entry,
    });
    if (finalized) {
      // The instance is reused across alias targets in one request, so publish
      // the finalized snapshot locally as well as durably.
      instance.modelsCache = entry;
      return models;
    }
    if (intent === 'background') return models;
    observedActiveToken = token;
  }
};

const inFlightKey = (instance: GatewayProvider): string => {
  const generation = instance.modelsCacheGeneration;
  return `${instance.upstreamId}\0${generation.updatedAt}\0${generation.fetchIdentity}`;
};

export const fetchUpstreamModels = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
  loadProvidedModels?: () => Promise<ProviderModel[]>,
): Promise<ProviderModel[]> => {
  const key = inFlightKey(instance);
  while (true) {
    const existing = inFlight.get(key);
    if (existing?.kind === 'refresh') {
      const joined = await existing.promise;
      if (joined !== null) return joined;
      if (inFlight.get(key) === existing) inFlight.delete(key);
      continue;
    }
    const models = await startInFlight(key, 'refresh', () => runClaimedRefresh(instance, fetcher, 'explicit', loadProvidedModels));
    if (models === null) throw new Error(`Failed to acquire models refresh for ${instance.upstreamId}`);
    return models;
  }
};

export const warmUpstreamModels = async (
  instance: GatewayProvider,
  fetcher: Fetcher,
): Promise<ProviderModel[]> => {
  const key = inFlightKey(instance);
  const existing = inFlight.get(key);
  if (existing) {
    const joined = await existing.promise;
    if (joined !== null) return joined;
    if (existing.kind === 'owner-wait') return instance.modelsCache?.models ?? [];
    if (inFlight.get(key) === existing) inFlight.delete(key);
  }

  const models = await memoInFlight(key, 'owner-wait', () => runClaimedRefresh(instance, fetcher, 'warm'));
  return models ?? instance.modelsCache?.models ?? [];
};

export const scheduleUpstreamModelsRefresh = (
  instance: GatewayProvider,
  scheduler: BackgroundScheduler,
  fetcher: Fetcher,
): void => {
  const key = inFlightKey(instance);
  scheduler(memoInFlight(key, 'refresh', () => runClaimedRefresh(instance, fetcher, 'background')).then(() => {}));
};

export const readUpstreamModelsSnapshotAndScheduleRefresh = (
  instance: GatewayProvider,
  opts: ModelsSnapshotReadOptions,
): ModelsSnapshot => {
  const { scheduler, fetcher } = opts;
  const now = Date.now();
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;
  const snapshot = {
    models: cached?.models ?? [],
    lastError: cached?.lastError ?? null,
  };

  if (!cached || now - cached.fetchedAt >= SOFT_MS) scheduleUpstreamModelsRefresh(instance, scheduler, fetcher);
  return snapshot;
};

// Test-only: drop the L1 map so a test's setup is independent of any
// promise the previous test left mid-settle.
export const clearInFlightForTesting = (): void => {
  inFlight.clear();
};
