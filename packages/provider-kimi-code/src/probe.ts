import { assertKimiCodeUpstreamRecord, type KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeEndpoint } from './endpoints.ts';
import { readKimiCodeUpstreamState, readKimiCodeAccount, type KimiCodeAccount, type KimiCodeObservation, type KimiCodeUpstreamState } from './state.ts';
import { kimiCodeMetrics } from './upstream-metrics.ts';
import { parseKimiCodeUsage } from './usage.ts';
import { readHttpResponseText } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { getProviderRepo, recordUpstreamMetrics, runScheduledUsageRefresh, type Fetcher, type ProviderScheduledOptions, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

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
): Promise<Result<boolean, unknown>> => {
  let accepted = false;
  const { upstreams } = getProviderRepo();
  try {
    await upstreams.saveState(upstreamId, (current, currentVersion) => {
      accepted = false;
      if (currentVersion !== configVersion) return current;
      const state = readKimiCodeUpstreamState(current);
      const previous = state[slot];
      if (previous !== null && previous.attemptedAt > attemptedAt) return current;
      accepted = true;
      return { ...state, [slot]: { attemptedAt, observation: observation ?? previous?.observation ?? null, error } };
    });
  } catch (error) {
    return { ok: false, error };
  }
  return { ok: true, value: accepted };
};

export type KimiCodeProbeFetcher = ReturnType<ProviderServices['fetcher']>;

const readKimiCodeJson = async (response: Response, path: string): Promise<Result<unknown, unknown>> => {
  const text = await readHttpResponseText(response);
  if (!text.ok) return { ok: false, error: text.error.cause };
  if (!response.ok) return { ok: false, error: new Error(`Kimi Code ${path} returned ${response.status}: ${text.value}`) };
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, error };
  }
};

const refreshProbe = async <T>(
  upstreamId: string,
  config: KimiCodeUpstreamConfig,
  fetcher: KimiCodeProbeFetcher,
  slot: keyof KimiCodeUpstreamState,
  path: string,
  read: (value: unknown) => Result<T, unknown>,
): Promise<Result<KimiCodeObservation<T>, unknown>> => {
  const attemptedAt = Date.now();
  // Draft credentials can be read under a saved id. Bind persistence only to
  // the saved configuration that produced this request; the SQL CAS rechecks
  // its version even when rotation occurs between the state read and write.
  const saved = upstreamId === '' ? null : await getProviderRepo().upstreams.getById(upstreamId);
  const savedConfig = saved === null ? null : assertKimiCodeUpstreamRecord(saved).config;
  const configVersion = saved !== null && savedConfig?.apiKey === config.apiKey && savedConfig.region === config.region ? saved.configVersion : null;
  const failed = async (error: unknown): Promise<Result<never, unknown>> => {
    if (configVersion !== null) {
      const message = error instanceof Error ? error.message : String(error);
      const persisted = await persistProbe(upstreamId, configVersion, slot, attemptedAt, null, message);
      if (!persisted.ok) {
        // Both failures matter and neither may be dropped. The aggregate's
        // message is the read failure's, so a caller matching on the upstream
        // status still sees it, while `errors` carries both.
        return { ok: false, error: new AggregateError([error, persisted.error], message) };
      }
    }
    return { ok: false, error };
  };
  const response = await fetcher(kimiCodeEndpoint(config.region, path), {
    method: 'GET', headers: [['accept', 'application/json'], ['authorization', `Bearer ${config.apiKey}`]],
  });
  if (!response.ok) return await failed(response.error.cause);
  const body = await readKimiCodeJson(response.value, path);
  if (!body.ok) return await failed(body.error);
  const parsed = read(body.value);
  if (!parsed.ok) return await failed(parsed.error);
  const observation = { fetchedAt: Date.now(), data: parsed.value };
  if (configVersion !== null) {
    const persisted = await persistProbe(upstreamId, configVersion, slot, attemptedAt, observation, null);
    if (!persisted.ok) return persisted;
    if (slot === 'usageProbe' && persisted.value) {
      const metrics = kimiCodeMetrics(observation.data);
      try {
        await recordUpstreamMetrics(upstreamId, metrics, observation.fetchedAt);
      } catch (error) {
        return { ok: false, error };
      }
    }
  }
  return { ok: true, value: observation };
};

const controlPlaneFetcher = (fetcher: Fetcher): KimiCodeProbeFetcher => async (url, init) => {
  try {
    return { ok: true, value: await fetcher(url, init) };
  } catch (cause) {
    return { ok: false, error: { kind: 'transport', cause } };
  }
};

const controlPlaneObservation = async <T>(task: Promise<Result<KimiCodeObservation<T>, unknown>>): Promise<KimiCodeObservation<T>> => {
  const result = await task;
  if (!result.ok) throw result.error;
  return result.value;
};

// The official client uses bearer authentication for /usages and /me.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-usage.ts#L218-L233
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L163-L178
export const probeKimiCodeUsage = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: KimiCodeProbeFetcher): Promise<Result<KimiCodeObservation<unknown>, unknown>> =>
  refreshProbe(upstreamId, config, fetcher, 'usageProbe', '/usages', value => {
    const parsed = parseKimiCodeUsage(value);
    return parsed.ok ? { ok: true, value } : parsed;
  });

// /me enriches the account's display identity; a failed profile read does not
// invalidate quota or inference.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-userinfo.ts#L43-L47
export const probeKimiCodeAccount = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: KimiCodeProbeFetcher): Promise<Result<KimiCodeObservation<KimiCodeAccount>, unknown>> =>
  refreshProbe(upstreamId, config, fetcher, 'accountProbe', '/me', readKimiCodeAccount);

export const refreshKimiCodeUsageProbe = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<unknown>> =>
  controlPlaneObservation(probeKimiCodeUsage(upstreamId, config, controlPlaneFetcher(fetcher)));

export const refreshKimiCodeAccountProbe = (upstreamId: string, config: KimiCodeUpstreamConfig, fetcher: Fetcher): Promise<KimiCodeObservation<KimiCodeAccount>> =>
  controlPlaneObservation(probeKimiCodeAccount(upstreamId, config, controlPlaneFetcher(fetcher)));

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
