import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeFetch, readKimiCodeJson } from './fetch.ts';
import { readKimiCodeUpstreamState, readKimiCodeAccount, type KimiCodeAccount, type KimiCodeObservation, type KimiCodeUpstreamState } from './state.ts';
import { kimiCodeMetrics } from './upstream-metrics.ts';
import { readKimiCodeUsage } from './usage.ts';
import { getProviderRepo, identityWrapUpstreamCall, recordUpstreamMetrics, runScheduledUsageRefresh, type Fetcher, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

// Request-triggered probes require the last persisted attempt to be at least one
// minute old for usage or one day old for identity. A 429 or 403 forces a usage
// refresh regardless of age. These are Floway polling policies.
export const KIMI_CODE_USAGE_INTERVAL_MS = 60_000;
export const KIMI_CODE_ACCOUNT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const persistProbe = async <T>(
  upstreamId: string,
  configVersion: number,
  slot: keyof KimiCodeUpstreamState,
  attemptedAt: number,
  observation: KimiCodeObservation<T> | null,
  error: string | null,
): Promise<boolean> => {
  let accepted = false;
  await getProviderRepo().upstreams.saveState(upstreamId, (current, currentVersion) => {
    accepted = false;
    if (currentVersion !== configVersion) return current;
    const state = readKimiCodeUpstreamState(current);
    const previous = state[slot];
    if (previous !== null && previous.attemptedAt > attemptedAt) return current;
    accepted = true;
    return { ...state, [slot]: { attemptedAt, observation: observation ?? previous?.observation ?? null, error } };
  });
  return accepted;
};

const refreshProbe = async <T>(
  upstreamId: string,
  config: KimiCodeUpstreamConfig,
  fetcher: Fetcher,
  slot: keyof KimiCodeUpstreamState,
  path: string,
  read: (value: unknown) => T,
): Promise<KimiCodeObservation<T>> => {
  const attemptedAt = Date.now();
  // Draft credentials can be read under a saved id. Bind persistence only to
  // the saved configuration that produced this request; the SQL CAS rechecks
  // its version even when rotation occurs between the state read and write.
  const saved = upstreamId === '' ? null : await getProviderRepo().upstreams.getById(upstreamId);
  const savedConfig = saved === null ? null : assertKimiCodeUpstreamRecord(saved).config;
  const configVersion = saved !== null && savedConfig?.apiKey === config.apiKey && savedConfig.region === config.region ? saved.configVersion : null;
  let observation: KimiCodeObservation<T>;
  try {
    const response = await kimiCodeFetch(config, path, { method: 'GET', headers: new Headers({ accept: 'application/json' }) }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    observation = { fetchedAt: Date.now(), data: read(await readKimiCodeJson(response, path)) };
  } catch (error) {
    if (configVersion !== null) {
      try {
        await persistProbe(upstreamId, configVersion, slot, attemptedAt, null, error instanceof Error ? error.message : String(error));
      } catch (persistenceError) {
        // Both failures matter and neither may be dropped. The aggregate's
        // message is the read failure's, so a caller matching on the upstream
        // status still sees it, while `errors` carries both.
        throw new AggregateError([error, persistenceError], error instanceof Error ? error.message : String(error));
      }
    }
    throw error;
  }
  if (configVersion !== null) {
    const accepted = await persistProbe(upstreamId, configVersion, slot, attemptedAt, observation, null);
    if (slot === 'usageProbe' && accepted) await recordUpstreamMetrics(upstreamId, kimiCodeMetrics(observation.data), observation.fetchedAt);
  }
  return observation;
};

// The official client uses bearer authentication for /usages and /me.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-usage.ts#L218-L233
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L163-L178
export const refreshKimiCodeUsageProbe = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<unknown>> =>
  refreshProbe(upstreamId, config, fetcher, 'usageProbe', '/usages', value => {
    readKimiCodeUsage(value);
    return value;
  });

// /me enriches the account's display identity; a failed profile read does not
// invalidate quota or inference.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L43-L47
export const refreshKimiCodeAccountProbe = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<KimiCodeAccount>> =>
  refreshProbe(upstreamId, config, fetcher, 'accountProbe', '/me', readKimiCodeAccount);

export const scheduleKimiCodeProbes = (record: UpstreamRecord, config: KimiCodeUpstreamConfig, fetcher: Fetcher, waitUntil: (promise: Promise<unknown>) => void, forceUsage: boolean): void => {
  const state = readKimiCodeUpstreamState(record.state);
  const now = Date.now();
  if (forceUsage || state.usageProbe === null || now - state.usageProbe.attemptedAt >= KIMI_CODE_USAGE_INTERVAL_MS) {
    waitUntil(refreshKimiCodeUsageProbe(record.id, config, fetcher).catch((error: unknown) => {
      console.warn(`Failed to refresh Kimi Code usage for ${record.id}:`, error);
    }));
  }
  if (state.accountProbe === null || now - state.accountProbe.attemptedAt >= KIMI_CODE_ACCOUNT_INTERVAL_MS) {
    waitUntil(refreshKimiCodeAccountProbe(record.id, config, fetcher).catch((error: unknown) => {
      console.warn(`Failed to refresh Kimi Code account for ${record.id}:`, error);
    }));
  }
};

export const runKimiCodeScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const { config } = assertKimiCodeUpstreamRecord(record);
  const state = readKimiCodeUpstreamState(record.state);
  await runScheduledUsageRefresh(record, options, state.usageProbe?.observation?.fetchedAt ?? null, async (fresh, fetcher) => {
    const outcomes = await Promise.allSettled([
      refreshKimiCodeUsageProbe(fresh.id, config, fetcher),
      ...(state.accountProbe === null || Date.now() - state.accountProbe.attemptedAt >= KIMI_CODE_ACCOUNT_INTERVAL_MS ? [refreshKimiCodeAccountProbe(fresh.id, config, fetcher)] : []),
    ]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason as unknown), 'Kimi Code scheduled probes failed');
  });
};
