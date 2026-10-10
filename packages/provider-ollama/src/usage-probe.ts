// Ollama account usage history and current cloud balance use separate APIs.
// GET /api/usage reports activity; GET /api/balance reports remaining quota.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx

import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { ollamaFetchUsage, ollamaFetchBalance } from './fetch.ts';
import { type OllamaUsageObservation, type OllamaUsageProbeEntry, type OllamaUpstreamState, readOllamaUpstreamState } from './state.ts';
import { type Fetcher, getProviderRepo, identityWrapUpstreamCall, runScheduledUsageRefresh, type ProviderScheduledOptions, type UpstreamRecord } from '@floway-dev/provider';

// Reading the windows takes two things the operator states: that this upstream
// is an Ollama Cloud account (`cloudUsage` — the endpoint belongs to
// ollama.com, and a base URL cannot settle it, since the cloud may be reached
// through the operator's own domain), and a key to authenticate with.
export const isOllamaUsageEnabled = (config: OllamaUpstreamConfig): boolean =>
  config.cloudUsage && config.apiKey !== undefined;

// Ollama recommends polling activity at most once per minute; this also bounds
// the post-inference probes.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
export const OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS = 60_000;

const readOllamaObservation = async (response: Response, path: string): Promise<OllamaUsageObservation> => {
  const rawText = await response.text();
  if (!response.ok) throw new Error(`Ollama ${path} returned ${response.status}: ${rawText.trim().slice(0, 256)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`Ollama ${path} returned a non-JSON body (${response.status})`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`Ollama ${path} returned a non-object body (${response.status})`);
  return { fetchedAt: Date.now(), data: parsed };
};

export const fetchOllamaUsageProbe = async (config: OllamaUpstreamConfig, fetcher: Fetcher): Promise<OllamaUsageObservation> =>
  await readOllamaObservation(await ollamaFetchUsage(config, { method: 'GET', headers: new Headers({ accept: 'application/json' }) },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }), '/api/usage');

export const fetchOllamaBalanceProbe = async (config: OllamaUpstreamConfig, fetcher: Fetcher): Promise<OllamaUsageObservation> =>
  await readOllamaObservation(await ollamaFetchBalance(config, { method: 'GET', headers: new Headers({ accept: 'application/json' }) },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }), '/api/balance');

// The entry is written under saveState's read-modify-CAS, and the mutator is
// re-run against whoever won a concurrent write. Two probes racing therefore
// resolve by attempt time rather than by write order, so the loser of the race
// cannot roll the slot back to its older reading. Equal stamps are not a
// rollback — the clock is coarser than the two attempts, and the later arrival
// is no staler — so only a strictly newer stored attempt wins.
const persistProbeEntry = async (upstreamId: string, slot: 'usageProbe' | 'balanceProbe', entry: OllamaUsageProbeEntry): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readOllamaUpstreamState(current);
    const previous = state[slot];
    if (previous && previous.attemptedAt > entry.attemptedAt) return current;
    return {
      ...state,
      [slot]: {
        attemptedAt: entry.attemptedAt,
        // A failed probe keeps the last good reading rather than blanking the
        // card; only a success replaces it.
        observation: entry.observation ?? previous?.observation ?? null,
        error: entry.error,
      },
    } satisfies OllamaUpstreamState;
  });
};

const refreshOllamaObservation = async (
  upstreamId: string,
  slot: 'usageProbe' | 'balanceProbe',
  fetchObservation: () => Promise<OllamaUsageObservation>,
): Promise<OllamaUsageObservation> => {
  const attemptedAt = Date.now();
  let observation: OllamaUsageObservation;
  try {
    observation = await fetchObservation();
  } catch (error) {
    try {
      await persistProbeEntry(upstreamId, slot, { attemptedAt, observation: null, error: error instanceof Error ? error.message : String(error) });
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], 'Ollama usage refresh and outcome persistence failed');
    }
    throw error;
  }
  await persistProbeEntry(upstreamId, slot, { attemptedAt, observation, error: null });
  return observation;
};

export const refreshOllamaUsageProbe = (upstreamId: string, config: OllamaUpstreamConfig, fetcher: Fetcher): Promise<OllamaUsageObservation> =>
  refreshOllamaObservation(upstreamId, 'usageProbe', () => fetchOllamaUsageProbe(config, fetcher));

export const refreshOllamaBalanceProbe = (upstreamId: string, config: OllamaUpstreamConfig, fetcher: Fetcher): Promise<OllamaUsageObservation> =>
  refreshOllamaObservation(upstreamId, 'balanceProbe', () => fetchOllamaBalanceProbe(config, fetcher));

const isOllamaUsageProbeDue = (state: OllamaUpstreamState, now: number): boolean => {
  const probe = state.usageProbe;
  return probe === null || now - probe.attemptedAt >= OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS;
};

// Fire-and-forget refresh behind the debounce, scheduled by the data plane
// once an upstream call that consumes the account's windows has been made.
// Every read the debounce needs is already in hand: `state` is the record this
// request was routed with, which the repo reads per request, so a probe that is
// not due costs nothing at all.
//
// Best-effort by construction: the response is already the caller's, and a
// usage card is strictly better-than-nothing information. A failure is
// recorded on the upstream — where the operator sees it — and never reaches
// the request.
export const scheduleOllamaUsageProbe = (
  upstreamId: string,
  config: OllamaUpstreamConfig,
  state: OllamaUpstreamState,
  fetcher: Fetcher,
  waitUntil: (promise: Promise<unknown>) => void,
): void => {
  if (!isOllamaUsageEnabled(config)) return;
  if (!isOllamaUsageProbeDue(state, Date.now())) return;
  waitUntil(refreshOllamaUsageProbe(upstreamId, config, fetcher).catch((error: unknown) => {
    console.warn(`Failed to refresh Ollama usage for ${upstreamId}:`, error);
  }));
};

export const runOllamaScheduledTask = async (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const { config } = assertOllamaUpstreamRecord(record);
  if (!isOllamaUsageEnabled(config)) return;
  const observedAt = readOllamaUpstreamState(record.state).balanceProbe?.observation?.fetchedAt ?? null;
  await runScheduledUsageRefresh(record, options, observedAt, async (fresh, fetcher) => {
    await refreshOllamaBalanceProbe(fresh.id, config, fetcher);
  });
};
