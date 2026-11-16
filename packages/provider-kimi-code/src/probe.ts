import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeFetch, readKimiCodeJson } from './fetch.ts';
import { readKimiCodeUpstreamState, readKimiCodeAccount, type KimiCodeAccount, type KimiCodeObservation, type KimiCodeUpstreamState } from './state.ts';
import { kimiCodeMetrics } from './upstream-metrics.ts';
import { readKimiCodeUsage, type KimiCodeUsageData } from './usage.ts';
import { object } from './validation.ts';
import { getProviderRepo, identityWrapUpstreamCall, recordUpstreamMetrics, runScheduledUsageRefresh, type Fetcher, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

// Request-triggered quota reads debounce for one minute; identity changes much
// less frequently and is refreshed once a day. These are Floway polling policies.
const USAGE_INTERVAL_MS = 60_000;
const ACCOUNT_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
        throw new AggregateError([error, persistenceError], 'Kimi Code probe and outcome persistence failed');
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

// The current CLI uses the same bearer token for /usages and optional /me.
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/auth/platforms.py#L27-L50
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/ui/shell/usage.py#L85-L200
export const refreshKimiCodeUsageProbe = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<KimiCodeUsageData>> =>
  refreshProbe(upstreamId, config, fetcher, 'usageProbe', '/usages', value => {
    readKimiCodeUsage(value);
    return value as KimiCodeUsageData;
  });

// /me enriches the account's display identity; a failed profile read does not
// invalidate quota or inference.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L43-L47
export const refreshKimiCodeAccountProbe = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<KimiCodeAccount>> =>
  refreshProbe(upstreamId, config, fetcher, 'accountProbe', '/me', value => {
    const body = object(value, 'Kimi Code /me');
    return readKimiCodeAccount({ userId: body.user_id, nickname: body.nickname, planName: body.user_level_name });
  });

export const scheduleKimiCodeProbes = (record: UpstreamRecord, config: KimiCodeUpstreamConfig, fetcher: Fetcher, waitUntil: (promise: Promise<unknown>) => void, forceUsage: boolean): void => {
  const state = readKimiCodeUpstreamState(record.state);
  const now = Date.now();
  if (forceUsage || state.usageProbe === null || now - state.usageProbe.attemptedAt >= USAGE_INTERVAL_MS) {
    waitUntil(refreshKimiCodeUsageProbe(record.id, config, fetcher).catch((error: unknown) => {
      console.warn(`Failed to refresh Kimi Code usage for ${record.id}:`, error);
    }));
  }
  if (state.accountProbe === null || now - state.accountProbe.attemptedAt >= ACCOUNT_INTERVAL_MS) {
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
      ...(state.accountProbe === null || Date.now() - state.accountProbe.attemptedAt >= ACCOUNT_INTERVAL_MS ? [refreshKimiCodeAccountProbe(fresh.id, config, fetcher)] : []),
    ]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason as unknown), 'Kimi Code scheduled probes failed');
  });
};
