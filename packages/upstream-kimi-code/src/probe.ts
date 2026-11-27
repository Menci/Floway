import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeFetch, readKimiCodeJson } from './fetch.ts';
import { readKimiCodeUpstreamState, readKimiCodeAccount, type KimiCodeAccount, type KimiCodeObservation, type KimiCodeUpstreamState } from './state.ts';
import { kimiCodeMetrics } from './upstream-metrics.ts';
import { readKimiCodeUsage } from './usage.ts';
import { getUpstreamRuntimeRepo, normalizeUpstreamMetricIdentity, runScheduledUsageRefresh, type Fetcher, type UpstreamRecord, type UpstreamRuntimeRepo, type UpstreamScheduledOptions } from '@floway-dev/upstream';

// Request-triggered probes require the last persisted attempt to be at least one
// minute old for usage or one day old for identity. A 429 or 403 forces a usage
// refresh regardless of age. These are Floway polling policies.
const USAGE_INTERVAL_MS = 60_000;
const ACCOUNT_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ProbePersistence {
  id: string;
  repo: UpstreamRuntimeRepo;
  version: number;
}

interface ProbeTarget {
  attemptedAt: number;
  config: KimiCodeUpstreamConfig;
  persistence: ProbePersistence | null;
}

const persistProbe = async <T>(
  { repo, id: upstreamId, version }: ProbePersistence,
  slot: keyof KimiCodeUpstreamState,
  attemptedAt: number,
  observation: KimiCodeObservation<T> | null,
  error: string | null,
): Promise<boolean> => {
  let accepted = false;
  await repo.upstreams.saveState(upstreamId, (current, currentVersion) => {
    accepted = false;
    if (currentVersion !== version) return current;
    const state = readKimiCodeUpstreamState(current);
    const previous = state[slot];
    if (previous !== null && previous.attemptedAt > attemptedAt) return current;
    accepted = true;
    return { ...state, [slot]: { attemptedAt, observation: observation ?? previous?.observation ?? null, error } };
  });
  return accepted;
};

const refreshProbe = async <T>(
  { attemptedAt, config, persistence }: ProbeTarget,
  fetcher: Fetcher,
  slot: keyof KimiCodeUpstreamState,
  path: string,
  read: (value: unknown) => T,
): Promise<KimiCodeObservation<T>> => {
  let observation: KimiCodeObservation<T>;
  try {
    const response = await kimiCodeFetch(config, path, { method: 'GET', headers: new Headers({ accept: 'application/json' }) }, fetcher);
    observation = { fetchedAt: Date.now(), data: read(await readKimiCodeJson(response, path)) };
  } catch (error) {
    if (persistence !== null) {
      try {
        await persistProbe(persistence, slot, attemptedAt, null, error instanceof Error ? error.message : String(error));
      } catch (persistenceError) {
        // Both failures matter and neither may be dropped. The aggregate's
        // message is the read failure's, so a caller matching on the upstream
        // status still sees it, while `errors` carries both.
        throw new AggregateError([error, persistenceError], error instanceof Error ? error.message : String(error));
      }
    }
    throw error;
  }
  if (persistence !== null) {
    const accepted = await persistProbe(persistence, slot, attemptedAt, observation, null);
    if (slot === 'usageProbe' && accepted) {
      await Promise.all(kimiCodeMetrics(observation.data).map(metric => {
        const { name, labels } = normalizeUpstreamMetricIdentity(metric.name, metric.labels);
        return persistence.repo.recordUpstreamMetric(persistence.id, name, labels, metric.value, observation.fetchedAt);
      }));
    }
  }
  return observation;
};

const sameConfig = (left: KimiCodeUpstreamConfig, right: KimiCodeUpstreamConfig): boolean => left.apiKey === right.apiKey && left.region === right.region;

const targetForProbe = async (id: string, config: KimiCodeUpstreamConfig): Promise<ProbeTarget> => {
  const attemptedAt = Date.now();
  if (id === '') return { attemptedAt, config, persistence: null };
  const repo = getUpstreamRuntimeRepo();
  // Draft credentials can be read under a saved id. Bind persistence only to
  // the saved configuration that produced this request; the SQL CAS rechecks
  // its version even when rotation occurs between the state read and write.
  const saved = await repo.upstreams.getById(id);
  const persistence = saved !== null && sameConfig(assertKimiCodeUpstreamRecord(saved).config, config) ? { repo, id, version: saved.version } : null;
  return { attemptedAt, config, persistence };
};

// The official client uses bearer authentication for /usages and /me.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-usage.ts#L218-L233
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L163-L178
const refreshUsage = (target: ProbeTarget, fetcher: Fetcher): Promise<KimiCodeObservation<unknown>> =>
  refreshProbe(target, fetcher, 'usageProbe', '/usages', value => {
    readKimiCodeUsage(value);
    return value;
  });

// /me enriches the account's display identity; a failed profile read does not
// invalidate quota or inference.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L43-L47
const refreshAccount = (target: ProbeTarget, fetcher: Fetcher): Promise<KimiCodeObservation<KimiCodeAccount>> =>
  refreshProbe(target, fetcher, 'accountProbe', '/me', readKimiCodeAccount);

export const refreshKimiCodeUsageProbe = async (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<unknown>> =>
  await refreshUsage(await targetForProbe(upstreamId, config), fetcher);

export const refreshKimiCodeAccountProbe = async (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<KimiCodeAccount>> =>
  await refreshAccount(await targetForProbe(upstreamId, config), fetcher);

export interface KimiCodeService {
  refreshProbes(id: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher, forceUsage: boolean): Promise<void>;
}

export const createKimiCodeService = (getRepo: () => UpstreamRuntimeRepo = getUpstreamRuntimeRepo): KimiCodeService => {
  const inFlight = new Map<string, Promise<unknown>>();
  const start = (id: string, version: number, probe: 'usage' | 'account', refresh: () => Promise<unknown>): Promise<unknown> => {
    const key = JSON.stringify([id, version, probe]);
    const active = inFlight.get(key);
    if (active !== undefined) return active;
    const promise = refresh().finally(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
    return promise;
  };
  return {
    async refreshProbes(id, config, fetcher, forceUsage) {
      const repo = getRepo();
      const current = await repo.upstreams.getById(id);
      if (current === null) return;
      const { state, config: currentConfig } = assertKimiCodeUpstreamRecord(current);
      if (!sameConfig(config, currentConfig)) return;
      const { version } = current;
      const { usageProbe, accountProbe } = readKimiCodeUpstreamState(state);
      const now = Date.now();
      const target = { attemptedAt: now, config, persistence: { repo, id, version } };
      const work: Promise<unknown>[] = [];
      if (forceUsage || usageProbe === null || now - usageProbe.attemptedAt >= USAGE_INTERVAL_MS) {
        work.push(start(id, version, 'usage', () => refreshUsage(target, fetcher)));
      }
      if (accountProbe === null || now - accountProbe.attemptedAt >= ACCOUNT_INTERVAL_MS) {
        work.push(start(id, version, 'account', () => refreshAccount(target, fetcher)));
      }
      const failures = (await Promise.allSettled(work)).filter(result => result.status === 'rejected');
      if (failures.length === 1) throw failures[0]!.reason;
      if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason as unknown), 'Kimi Code active probes failed');
    },
  };
};

export const runKimiCodeScheduledTask = async (record: UpstreamRecord, options: UpstreamScheduledOptions): Promise<void> => {
  const { config } = assertKimiCodeUpstreamRecord(record);
  const state = readKimiCodeUpstreamState(record.state);
  await runScheduledUsageRefresh(record, options, state.usageProbe?.observation?.fetchedAt ?? null, async (fresh, fetcher) => {
    const outcomes = await Promise.allSettled([
      refreshKimiCodeUsageProbe(fresh.id, config, fetcher),
      ...(state.accountProbe === null || Date.now() - state.accountProbe.attemptedAt >= ACCOUNT_INTERVAL_MS ? [refreshKimiCodeAccountProbe(fresh.id, config, fetcher)] : []),
    ]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason as unknown), 'Kimi Code scheduled probes failed');
  });
};
